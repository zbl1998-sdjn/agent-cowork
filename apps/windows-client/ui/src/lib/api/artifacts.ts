// 制品 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:封装可视化制品的渲染/读取/列出/重命名,渲染前先预检申请文件写入审批再落盘。
// 依赖/对应路由:POST /api/viz/render(/preview)、GET /api/artifacts、GET /api/artifacts/view、POST /api/artifacts/rename、活页数据/视图 URL。导出:renderViz / previewVizRender / fetchArtifactHtml / fetchLiveArtifactData / liveArtifactUrl / listArtifacts / artifactViewUrl / renameArtifact + 相关类型。
import { authHeaders, getJson, hostReady, newIdempotencyKey, postJson, resolveUrl } from './transport';

export async function fetchArtifactHtml(viewUrl: string): Promise<string> {
  await hostReady;
  const response = await fetch(viewUrl, { headers: authHeaders({ accept: 'text/html' }) });
  if (!response.ok) throw new Error(`artifact view returned ${response.status}`);
  return response.text();
}

export type VizKind = 'bar' | 'line' | 'pie' | 'doughnut' | 'mermaid' | 'table';

export interface VizSpec {
  id?: string;
  title?: string;
  kind: VizKind;
  data?: unknown;
  options?: unknown;
  definition?: string;
  dataSource?: { type?: string; path?: string };
}

export interface VizRenderResult {
  kind: string;
  html: string;
  persisted: boolean;
  id?: string;
  relativePath?: string;
  dataUrl?: string;
  viewUrl?: string;
}

export interface VizRenderPreview {
  id: string;
  relativePath: string;
  dataUrl: string;
  viewUrl: string;
  fileOperationApprovalId: string;
}

export interface LiveArtifactData {
  id: string;
  title?: string;
  viz?: VizSpec;
  refreshedAt?: string;
  dataSource?: { type?: string; path?: string };
}

export async function previewVizRender(spec: VizSpec, trustedRoot?: string): Promise<VizRenderPreview> {
  return postJson('/api/viz/render/preview', { ...spec, trustedRoot });
}

export async function renderViz(spec: VizSpec, persist = true, trustedRoot?: string): Promise<VizRenderResult> {
  if (!persist) {
    return postJson('/api/viz/render', { ...spec, persist: false, trustedRoot, idempotencyKey: newIdempotencyKey('viz') });
  }
  const preview = await previewVizRender(spec, trustedRoot);
  return postJson('/api/viz/render', {
    ...spec,
    id: preview.id,
    persist: true,
    trustedRoot,
    fileOperationApprovalId: preview.fileOperationApprovalId,
    idempotencyKey: newIdempotencyKey('viz'),
  });
}

export async function fetchLiveArtifactData(dataUrl: string): Promise<LiveArtifactData> {
  return getJson<LiveArtifactData>(dataUrl);
}

export function liveArtifactUrl(viewUrl: string): string {
  return resolveUrl(viewUrl);
}

export interface ArtifactItem {
  path: string;
  name: string;
  relativePath?: string;
  kind?: string;
  size?: number;
  mtime?: string;
  modifiedAt?: string;
  viewable?: boolean;
  liveArtifactId?: string;
}

export interface ArtifactVersionSummary {
  id: string;
  lineageId: string;
  parentVersionId?: string;
  contentSha256: string;
  hashVerified: boolean;
  title: string;
  createdAt: string;
  viewUrl: string;
}

export interface ArtifactVersionDraft {
  id?: string;
  title?: string;
  viz?: VizSpec;
  dataSource?: unknown;
}

export interface ArtifactVersionPreview {
  id: string;
  parentVersionId: string;
  relativePath: string;
  dataUrl: string;
  viewUrl: string;
  title: string;
  vizKind: string;
  dataSourceType: string;
  parentContentSha256: string;
  approvalPlanSha256: string;
  operationCount: number;
  fileOperationApprovalId: string;
}

export interface PublishedArtifactVersion {
  id: string;
  parentVersionId: string;
  lineageId: string;
  relativePath: string;
  dataUrl: string;
  viewUrl: string;
  idempotentReplay?: boolean;
}

export async function listArtifacts(trustedRoot?: string, limit = 30): Promise<ArtifactItem[]> {
  const params = new URLSearchParams();
  if (trustedRoot) params.set('trustedRoot', trustedRoot);
  params.set('limit', String(limit));
  const res = await getJson<{ artifacts: ArtifactItem[] }>(`/api/artifacts?${params.toString()}`);
  return res.artifacts || [];
}

export async function listArtifactVersions(
  artifactId: string,
  trustedRoot?: string,
): Promise<ArtifactVersionSummary[]> {
  const params = new URLSearchParams();
  if (trustedRoot) params.set('trustedRoot', trustedRoot);
  const query = params.toString();
  const res = await getJson<{ versions?: ArtifactVersionSummary[] }>(
    `/api/artifacts/live/${encodeURIComponent(artifactId)}/history${query ? `?${query}` : ''}`,
  );
  return Array.isArray(res.versions) ? res.versions : [];
}

export async function previewArtifactVersion(
  parentVersionId: string,
  draft: ArtifactVersionDraft,
  trustedRoot?: string,
): Promise<ArtifactVersionPreview> {
  return postJson(
    `/api/artifacts/live/${encodeURIComponent(parentVersionId)}/versions/preview`,
    { ...draft, trustedRoot },
  );
}

export async function publishArtifactVersion(
  parentVersionId: string,
  draft: ArtifactVersionDraft,
  preview: ArtifactVersionPreview,
  trustedRoot?: string,
): Promise<PublishedArtifactVersion> {
  return postJson(
    `/api/artifacts/live/${encodeURIComponent(parentVersionId)}/versions`,
    {
      ...draft,
      id: preview.id,
      trustedRoot,
      fileOperationApprovalId: preview.fileOperationApprovalId,
      idempotencyKey: newIdempotencyKey('artifact-version'),
    },
  );
}

export function artifactViewUrl(path: string, trustedRoot?: string): string {
  const params = new URLSearchParams();
  params.set('path', path);
  if (trustedRoot) params.set('trustedRoot', trustedRoot);
  return resolveUrl(`/api/artifacts/view?${params.toString()}`);
}

export async function renameArtifact(
  path: string,
  newName: string,
  trustedRoot?: string,
): Promise<{ artifact: ArtifactItem }> {
  return postJson('/api/artifacts/rename', {
    path,
    newName,
    trustedRoot,
    idempotencyKey: newIdempotencyKey('artifact-rename'),
  });
}
