import { getJson, newIdempotencyKey, postJson, sendJsonMethod } from './transport';

export interface ProjectRecord {
  id: string;
  name: string;
  color?: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  stats: { conversations: number; artifacts: number };
  conversations: string[];
  artifacts: string[];
}

export interface ProjectListResponse {
  trustedRoot: string;
  projects: ProjectRecord[];
}

function trustedParams(trustedRoot?: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra || {});
  if (trustedRoot) params.set('trustedRoot', trustedRoot);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function listProjects(trustedRoot?: string, includeArchived = false): Promise<ProjectListResponse> {
  return getJson<ProjectListResponse>(`/api/projects${trustedParams(trustedRoot, includeArchived ? { includeArchived: '1' } : undefined)}`);
}

export async function createProject(name: string, color?: string | null, trustedRoot?: string): Promise<{ project: ProjectRecord }> {
  return postJson('/api/projects', {
    name,
    color,
    trustedRoot,
    idempotencyKey: newIdempotencyKey('project-create'),
  });
}

export async function updateProject(
  id: string,
  patch: { name?: string; color?: string | null; archived?: boolean },
  trustedRoot?: string,
): Promise<{ project: ProjectRecord }> {
  return sendJsonMethod('PATCH', `/api/projects/${encodeURIComponent(id)}`, {
    ...patch,
    trustedRoot,
    idempotencyKey: newIdempotencyKey('project-update'),
  });
}

export async function deleteProject(id: string, trustedRoot?: string): Promise<{ deleted: boolean }> {
  return sendJsonMethod('DELETE', `/api/projects/${encodeURIComponent(id)}`, {
    trustedRoot,
    idempotencyKey: newIdempotencyKey('project-delete'),
  });
}

export async function assignProjectConversation(
  id: string,
  conversationId: string,
  trustedRoot?: string,
): Promise<{ project: ProjectRecord }> {
  return postJson(`/api/projects/${encodeURIComponent(id)}/conversations`, {
    conversationId,
    trustedRoot,
    idempotencyKey: newIdempotencyKey('project-conv'),
  });
}

export async function assignProjectArtifact(
  id: string,
  artifactId: string,
  trustedRoot?: string,
): Promise<{ project: ProjectRecord }> {
  return postJson(`/api/projects/${encodeURIComponent(id)}/artifacts`, {
    artifactId,
    trustedRoot,
    idempotencyKey: newIdempotencyKey('project-artifact'),
  });
}
