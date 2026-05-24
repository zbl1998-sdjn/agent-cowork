import { authHeaders, getJson, hostReady, newIdempotencyKey, postJson, resolveUrl } from './transport';

export async function fetchArtifactHtml(viewUrl: string): Promise<string> {
  await hostReady;
  const response = await fetch(viewUrl, { headers: authHeaders({ accept: 'text/html' }) });
  if (!response.ok) throw new Error(`artifact view returned ${response.status}`);
  return response.text();
}

export type VizKind = 'bar' | 'line' | 'pie' | 'doughnut' | 'mermaid' | 'table';

export interface VizSpec {
  title?: string;
  kind: VizKind;
  data?: unknown;
  options?: unknown;
  definition?: string;
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

export interface LiveArtifactData {
  id: string;
  title?: string;
  viz?: VizSpec;
  refreshedAt?: string;
  dataSource?: { type?: string; path?: string };
}

export async function renderViz(spec: VizSpec, persist = true, trustedRoot?: string): Promise<VizRenderResult> {
  return postJson('/api/viz/render', { ...spec, persist, trustedRoot, idempotencyKey: newIdempotencyKey('viz') });
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
}

export async function listArtifacts(trustedRoot?: string, limit = 30): Promise<ArtifactItem[]> {
  const params = new URLSearchParams();
  if (trustedRoot) params.set('trustedRoot', trustedRoot);
  params.set('limit', String(limit));
  const res = await getJson<{ artifacts: ArtifactItem[] }>(`/api/artifacts?${params.toString()}`);
  return res.artifacts || [];
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
