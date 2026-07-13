// Office/Web 可视化编辑 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:建立编辑会话，并以“预检审批 → 保存副本”的两阶段协议提交组件级修改。
import { getJson, newIdempotencyKey, postJson, resolveUrl } from './transport';

export type OfficeEditorKind = 'docx' | 'xlsx' | 'pptx' | 'html';
export interface OfficeEditorNode {
  id: string;
  type: 'paragraph' | 'cell' | 'shape';
  text: string;
  address?: string;
  readOnly?: boolean;
}
export interface OfficeEditorSection { id: string; label: string; nodes: OfficeEditorNode[] }
export interface OfficeEditorSession {
  kind: OfficeEditorKind;
  name: string;
  revisionSha256: string;
  sections: OfficeEditorSection[];
  htmlSource?: string;
}
export interface OfficeEditorChange { targetId: string; text: string }
export interface OfficeEditorSaveResult {
  path: string;
  name: string;
  outputSha256: string;
  session: OfficeEditorSession;
}

export interface OnlyOfficeStatus {
  enabled: boolean;
  configured: boolean;
  healthy: boolean;
  detail: string;
  missing: string[];
}

export interface OnlyOfficeSessionResult {
  path: string;
  name: string;
  documentKey: string;
  expiresAt: string;
  editorPath: string;
  editorUrl: string;
}

export interface OnlyOfficeSaveStatus {
  saved: boolean;
  path: string;
  name: string;
  outputSha256?: string;
}

export async function openOfficeEditorSession(
  path: string,
  trustedRoot?: string,
): Promise<OfficeEditorSession> {
  const result = await postJson<{ session: OfficeEditorSession }>('/api/artifacts/editor/session', {
    path,
    trustedRoot,
  });
  return result.session;
}

export async function saveOfficeEditorCopy(input: {
  path: string;
  trustedRoot?: string;
  revisionSha256: string;
  copyName: string;
  changes: OfficeEditorChange[];
}): Promise<OfficeEditorSaveResult> {
  const preview = await postJson<{ fileOperationApprovalId: string }>('/api/artifacts/editor/save/preview', input);
  return postJson<OfficeEditorSaveResult>('/api/artifacts/editor/save', {
    ...input,
    fileOperationApprovalId: preview.fileOperationApprovalId,
    idempotencyKey: newIdempotencyKey('office-visual-save'),
  });
}

export function supportsOnlyOffice(name: string): boolean {
  return /\.(docx|xlsx|pptx)$/iu.test(name);
}

export async function getOnlyOfficeStatus(): Promise<OnlyOfficeStatus> {
  return getJson<OnlyOfficeStatus>('/api/artifacts/onlyoffice/status');
}

export async function startOnlyOfficeSession(input: {
  path: string;
  trustedRoot?: string;
  copyName: string;
}): Promise<OnlyOfficeSessionResult> {
  const preview = await postJson<{ fileOperationApprovalId: string }>(
    '/api/artifacts/onlyoffice/session/preview',
    input,
  );
  const result = await postJson<Omit<OnlyOfficeSessionResult, 'editorUrl'>>(
    '/api/artifacts/onlyoffice/session',
    {
      ...input,
      fileOperationApprovalId: preview.fileOperationApprovalId,
      idempotencyKey: newIdempotencyKey('onlyoffice-session'),
    },
  );
  return { ...result, editorUrl: resolveUrl(result.editorPath) };
}

export async function getOnlyOfficeSaveStatus(editorPath: string): Promise<OnlyOfficeSaveStatus> {
  const session = new URL(editorPath, 'http://127.0.0.1').searchParams.get('session');
  if (!session) throw new Error('ONLYOFFICE editor session is invalid');
  return getJson<OnlyOfficeSaveStatus>(
    `/api/artifacts/onlyoffice/session/status?session=${encodeURIComponent(session)}`,
  );
}
