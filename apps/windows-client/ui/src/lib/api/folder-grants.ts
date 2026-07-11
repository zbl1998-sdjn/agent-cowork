// Connected-folder grant API (UI · lib/api).
// The selected grant id is transported by the shared HTTP layer; paths are
// returned for display/current workspace state but are never persisted here.
import { getJson, newIdempotencyKey, postJson, sendJsonMethod } from './transport';

export interface FolderGrant {
  id: string;
  path: string;
  displayName: string;
  source: 'system' | 'picker' | 'manual';
  status: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  supersedesGrantId: string | null;
}

export function listFolderGrants(includeRevoked = false): Promise<{ grants: FolderGrant[] }> {
  return getJson(`/api/folder-grants${includeRevoked ? '?includeRevoked=1' : ''}`);
}

export function createFolderGrant(
  path: string,
  source: 'picker' | 'manual' = 'manual',
  displayName?: string,
): Promise<{ grant: FolderGrant }> {
  return postJson('/api/folder-grants', {
    path,
    source,
    ...(displayName ? { displayName } : {}),
    idempotencyKey: newIdempotencyKey('folder-grant-create'),
  });
}

export function revokeFolderGrant(id: string): Promise<{ grant: FolderGrant }> {
  return sendJsonMethod('DELETE', `/api/folder-grants/${encodeURIComponent(id)}`, {
    idempotencyKey: newIdempotencyKey('folder-grant-revoke'),
  });
}
