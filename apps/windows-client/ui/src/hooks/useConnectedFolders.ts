// Connected-folder state orchestration (UI · hooks).
// Components receive active grants and callbacks; only the opaque selected id
// is persisted by transport, while the current path remains App memory state.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createFolderGrant,
  getWorkspaceGrantId,
  listFolderGrants,
  revokeFolderGrant,
  setWorkspaceGrantId,
  type FolderGrant,
} from '../lib/api';

export function resolveFolderGrantRevocation(
  grants: readonly FolderGrant[],
  selectedId: string | null,
  revokedId: string,
): { grants: FolderGrant[]; selected: FolderGrant | null } {
  const remaining = grants.filter((grant) => grant.id !== revokedId);
  const selected = selectedId === revokedId
    ? remaining.find((grant) => grant.source === 'system') ?? null
    : remaining.find((grant) => grant.id === selectedId) ?? null;
  return { grants: remaining, selected };
}

export function useConnectedFolders(current: string, onSwitch: (path: string) => void) {
  const [grants, setGrants] = useState<FolderGrant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(getWorkspaceGrantId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refreshSequence = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const sequence = ++refreshSequence.current;
    setBusy(true);
    setError('');
    try {
      const response = await listFolderGrants();
      if (sequence !== refreshSequence.current) return;
      const active = response.grants.filter((grant) => grant.status === 'active');
      setGrants(active);
      const storedId = getWorkspaceGrantId();
      const selected = active.find((grant) => grant.id === storedId)
        ?? active.find((grant) => grant.path === current)
        ?? active.find((grant) => grant.source === 'system')
        ?? null;
      setWorkspaceGrantId(selected?.id ?? null);
      setSelectedId(selected?.id ?? null);
      if (selected && selected.path !== current) onSwitch(selected.path);
    } catch (reason) {
      if (sequence === refreshSequence.current) {
        setError((reason as Error).message || '读取已连接文件夹失败');
      }
    } finally {
      if (sequence === refreshSequence.current) setBusy(false);
    }
  }, [current, onSwitch]);

  useEffect(() => {
    void refresh();
    return () => { refreshSequence.current += 1; };
  }, [refresh]);

  const select = useCallback((grant: FolderGrant): void => {
    if (grant.status !== 'active') return;
    setWorkspaceGrantId(grant.id);
    setSelectedId(grant.id);
    setError('');
    onSwitch(grant.path);
  }, [onSwitch]);

  const connect = useCallback(async (
    folderPath: string,
    source: 'picker' | 'manual',
  ): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const { grant } = await createFolderGrant(folderPath, source);
      setGrants((currentGrants) => [
        grant,
        ...currentGrants.filter((candidate) => candidate.id !== grant.id),
      ]);
      setWorkspaceGrantId(grant.id);
      setSelectedId(grant.id);
      onSwitch(grant.path);
      return true;
    } catch (reason) {
      setError((reason as Error).message || '连接文件夹失败');
      return false;
    } finally {
      setBusy(false);
    }
  }, [onSwitch]);

  const revoke = useCallback(async (grantId: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      await revokeFolderGrant(grantId);
      const selectedBefore = getWorkspaceGrantId() === grantId ? grantId : selectedId;
      const next = resolveFolderGrantRevocation(grants, selectedBefore, grantId);
      setGrants(next.grants);
      if (selectedBefore === grantId) {
        setWorkspaceGrantId(next.selected?.id ?? null);
        setSelectedId(next.selected?.id ?? null);
        if (next.selected) onSwitch(next.selected.path);
      }
      await refresh();
      return true;
    } catch (reason) {
      setError((reason as Error).message || '撤销文件夹授权失败');
      return false;
    } finally {
      setBusy(false);
    }
  }, [grants, onSwitch, refresh, selectedId]);

  return { grants, selectedId, busy, error, connect, select, revoke, refresh };
}
