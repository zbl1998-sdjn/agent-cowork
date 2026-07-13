// ONLYOFFICE 面板状态(UI · hooks)
// ---------------------------------------------------------------------------
// 职责:探测 Document Server、启动审批会话，并轮询回调副本状态；组件只渲染结果。
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getOnlyOfficeSaveStatus,
  getOnlyOfficeStatus,
  startOnlyOfficeSession,
  type ArtifactItem,
  type OnlyOfficeSessionResult,
  type OnlyOfficeStatus,
} from '../lib/api';

const DISABLED: OnlyOfficeStatus = {
  enabled: false, configured: false, healthy: false, detail: 'disabled', missing: [],
};

export function useOnlyOfficeEditor(
  item: ArtifactItem,
  trustedRoot: string,
  onSaved: (path: string) => void,
) {
  const [status, setStatus] = useState<OnlyOfficeStatus>(DISABLED);
  const [session, setSession] = useState<OnlyOfficeSessionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reportedPath = useRef('');

  const refreshStatus = useCallback(async () => {
    try { setStatus(await getOnlyOfficeStatus()); }
    catch (reason) { setError((reason as Error).message); }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (!session) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await getOnlyOfficeSaveStatus(session.editorPath);
        if (!stopped && result.saved && reportedPath.current !== result.path) {
          reportedPath.current = result.path;
          onSaved(result.path);
        }
      } catch (reason) {
        if (!stopped) setError((reason as Error).message);
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 2_000);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [onSaved, session]);

  const open = useCallback(async (copyName: string) => {
    setBusy(true);
    setError('');
    reportedPath.current = '';
    try {
      setSession(await startOnlyOfficeSession({ path: item.path, trustedRoot, copyName }));
    } catch (reason) {
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }, [item.path, trustedRoot]);

  const close = useCallback(() => setSession(null), []);
  return { status, session, busy, error, open, close, refreshStatus };
}
