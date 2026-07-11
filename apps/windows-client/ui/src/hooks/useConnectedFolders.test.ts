import { describe, expect, it } from 'vitest';

import type { FolderGrant } from '../lib/api';
import { resolveFolderGrantRevocation } from './useConnectedFolders';

function grant(id: string, source: FolderGrant['source'], path: string): FolderGrant {
  return {
    id,
    path,
    displayName: id,
    source,
    status: 'active',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    revokedAt: null,
    supersedesGrantId: null,
  };
}

describe('connected-folder revoke state', () => {
  it('immediately removes the revoked selection and falls back to the system grant', () => {
    const system = grant('grant_system-1', 'system', 'C:\\workspace');
    const connected = grant('grant_connected-1', 'manual', 'C:\\workspace\\connected');

    const next = resolveFolderGrantRevocation([system, connected], connected.id, connected.id);

    expect(next.grants).toEqual([system]);
    expect(next.selected).toEqual(system);
  });
});
