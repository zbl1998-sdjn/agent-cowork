// Office/Web 可视化编辑状态(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:加载会话、维护即时草稿/撤销栈，并调用两阶段保存 API；组件只负责渲染和回调。
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  openOfficeEditorSession,
  saveOfficeEditorCopy,
  type ArtifactItem,
  type OfficeEditorChange,
  type OfficeEditorSession,
} from '../lib/api';
import type { WebSnapshotReason } from '../lib/types/webEditor';

type DraftState = Readonly<{ drafts: Record<string, string>; html: string }>;
const EMPTY_DRAFT: DraftState = Object.freeze({ drafts: {}, html: '' });

export function useOfficeVisualEditor(item: ArtifactItem, trustedRoot: string, onSaved: (path: string) => void) {
  const [session, setSession] = useState<OfficeEditorSession | null>(null);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [history, setHistory] = useState<DraftState[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [activeSectionId, setActiveSectionId] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const next = await openOfficeEditorSession(item.path, trustedRoot);
      const firstSection = next.sections[0];
      const firstNode = firstSection?.nodes.find((node) => !node.readOnly) || firstSection?.nodes[0];
      setSession(next);
      setDraft({ drafts: {}, html: next.htmlSource || '' });
      setHistory([]);
      setActiveSectionId(firstSection?.id || '');
      setSelectedId(firstNode?.id || '');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, [item.path, trustedRoot]);

  useEffect(() => { void load(); }, [load]);

  const commit = useCallback((next: DraftState) => {
    setDraft((current) => {
      setHistory((items) => [...items.slice(-29), current]);
      return next;
    });
  }, []);
  const updateNode = useCallback((targetId: string, text: string) => {
    commit({ ...draft, drafts: { ...draft.drafts, [targetId]: text } });
  }, [commit, draft]);
  const updateHtml = useCallback((html: string, reason: WebSnapshotReason = 'mutation') => {
    if (reason === 'undo') {
      setDraft((current) => ({ ...current, html }));
      setHistory((items) => items.slice(0, -1));
      return;
    }
    setDraft((current) => {
      if (current.html === html) return current;
      setHistory((items) => [...items.slice(-29), current]);
      return { ...current, html };
    });
  }, []);
  const undo = useCallback(() => {
    setHistory((items) => {
      const previous = items.at(-1);
      if (previous) setDraft(previous);
      return previous ? items.slice(0, -1) : items;
    });
  }, []);

  const changes = useMemo<OfficeEditorChange[]>(() => {
    if (!session) return [];
    if (session.kind === 'html') {
      return draft.html !== (session.htmlSource || '') ? [{ targetId: 'document', text: draft.html }] : [];
    }
    return Object.entries(draft.drafts).map(([targetId, text]) => ({ targetId, text }));
  }, [draft, session]);

  const save = useCallback(async (copyName: string) => {
    if (!session || changes.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const result = await saveOfficeEditorCopy({
        path: item.path,
        trustedRoot,
        revisionSha256: session.revisionSha256,
        copyName,
        changes,
      });
      onSaved(result.path);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }, [changes, item.path, onSaved, session, trustedRoot]);

  return {
    session, draft, selectedId, activeSectionId, busy, error, changes,
    setSelectedId, setActiveSectionId, updateNode, updateHtml, undo, save, load,
    canUndo: history.length > 0,
  };
}
