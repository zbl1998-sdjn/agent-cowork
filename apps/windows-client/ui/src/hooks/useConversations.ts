import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeConversationMessages,
  compactConversationForStorage,
  forkConversationBeforeMessage,
  switchConversationBranch,
  updateActiveConversationMessages,
} from '../lib/conversation-branches';
import {
  deleteStoredConversation,
  getStoredConversation,
  listStoredConversations,
  saveStoredConversation,
  searchStoredConversations,
  type AuthIdentity,
} from '../lib/api';
import { convTitle, conversationToMarkdown } from '../lib/conversations';
import { CONV_KEY, downloadText, loadConversations, nextBranchId, nextConvId } from '../lib/app-constants';
import type { Conversation, Message } from '../lib/app-types';

interface UseConversationsArgs {
  messages: Message[];
  setMessages: (updater: Message[] | ((current: Message[]) => Message[])) => void;
  setSelectedRecipe: (recipe: null) => void;
  streamingId: string | null;
  user: AuthIdentity | null;
}

export function useConversations({ messages, setMessages, setSelectedRecipe, streamingId, user }: UseConversationsArgs) {
  const initialConversationsRef = useRef<Conversation[] | null>(null);
  if (!initialConversationsRef.current) initialConversationsRef.current = loadConversations();

  const [conversations, setConversations] = useState<Conversation[]>(initialConversationsRef.current);
  const [activeConvId, setActiveConvId] = useState<string>(initialConversationsRef.current[0].id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [convSearch, setConvSearch] = useState('');

  useEffect(() => {
    setConversations((cs) => cs.map((c) => {
      if (c.id !== activeConvId) return c;
      const updated = updateActiveConversationMessages(c, messages);
      return { ...updated, title: convTitle(messages, c.title) };
    }));
  }, [messages, activeConvId]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(CONV_KEY, JSON.stringify(conversations.slice(0, 50).map((c) => compactConversationForStorage(c, { messageLimit: 60 }))));
      } catch { /* ignore quota */ }
      if (user) {
        const active = conversations.find((c) => c.id === activeConvId);
        if (active && active.messages.length > 0) {
          const compact = compactConversationForStorage(active, { messageLimit: 80 });
          void saveStoredConversation(active.id, {
            title: compact.title,
            pinned: compact.pinned,
            messages: compact.messages,
            activeBranchId: compact.activeBranchId,
            branches: compact.branches,
          });
        }
      }
    }, 600);
    return () => clearTimeout(t);
  }, [conversations, activeConvId, user]);

  const convSyncedRef = useRef(false);
  useEffect(() => {
    if (!user) { convSyncedRef.current = false; return; }
    if (convSyncedRef.current) return;
    convSyncedRef.current = true;
    void (async () => {
      const remote = await listStoredConversations();
      if (remote.length) {
        const convs: Conversation[] = remote.map((c) => ({
          id: c.id,
          title: c.title || '新对话',
          pinned: c.pinned,
          messages: (c.messages as Message[]) || [],
          activeBranchId: c.activeBranchId,
          branches: c.branches as Conversation['branches'],
        }));
        setConversations(convs);
        setActiveConvId(convs[0].id);
        setMessages(activeConversationMessages(convs[0]));
      }
    })();
  }, [user, setMessages]);

  const visibleConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const filtered = q
      ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q) || c.messages.some((m) => (m.text || '').toLowerCase().includes(q)))
      : conversations;
    return [...filtered].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }, [conversations, convSearch]);

  const newConversation = useCallback(() => {
    if (streamingId) return;
    const id = nextConvId();
    setConversations((cs) => [{ id, title: '新对话', messages: [] }, ...cs]);
    setActiveConvId(id);
    setMessages([]);
    setSelectedRecipe(null);
  }, [streamingId, setMessages, setSelectedRecipe]);

  const switchConversation = useCallback((id: string) => {
    if (id === activeConvId || streamingId) return;
    const c = conversations.find((x) => x.id === id);
    setActiveConvId(id);
    setMessages(c ? activeConversationMessages(c) : []);
    if (user && c && c.messages.length === 0) {
      void (async () => {
        const full = await getStoredConversation(id);
        const msgs = (full && Array.isArray(full.messages) ? full.messages : []) as Message[];
        const hydrated = full
          ? { ...c, messages: msgs, activeBranchId: full.activeBranchId, branches: full.branches as Conversation['branches'] }
          : null;
        if (hydrated && activeConversationMessages(hydrated).length) {
          const activeMessages = activeConversationMessages(hydrated);
          setMessages((cur) => (cur.length === 0 ? activeMessages : cur));
          setConversations((cs) => cs.map((x) => (x.id === id ? hydrated : x)));
        }
      })();
    }
  }, [activeConvId, streamingId, conversations, user, setMessages]);

  useEffect(() => {
    const q = convSearch.trim();
    if (!user || !q) return;
    const t = setTimeout(() => {
      void (async () => {
        const { items } = await searchStoredConversations(q, 20, 0);
        if (!items.length) return;
        setConversations((cs) => {
          const known = new Set(cs.map((c) => c.id));
          const extra = items
            .filter((it) => !known.has(it.id))
            .map((it) => ({ id: it.id, title: it.title || '新对话', pinned: it.pinned, messages: [] as Message[] }));
          return extra.length ? [...cs, ...extra] : cs;
        });
      })();
    }, 350);
    return () => clearTimeout(t);
  }, [convSearch, user]);

  const renameConversation = useCallback((id: string, title: string) => {
    const t = (title || '').trim();
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title: t || c.title || '新对话' } : c)));
  }, []);
  const commitRename = useCallback(() => {
    if (renamingId) renameConversation(renamingId, renameText);
    setRenamingId(null);
  }, [renamingId, renameText, renameConversation]);
  const deleteConversation = useCallback((id: string) => {
    if (streamingId) return;
    if (user) void deleteStoredConversation(id);
    const remaining = conversations.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const nid = nextConvId();
      setConversations([{ id: nid, title: '新对话', messages: [] }]);
      setActiveConvId(nid);
      setMessages([]);
      return;
    }
    setConversations(remaining);
    if (id === activeConvId) {
      setActiveConvId(remaining[0].id);
      setMessages(activeConversationMessages(remaining[0]));
    }
  }, [conversations, activeConvId, streamingId, user, setMessages]);
  const togglePin = useCallback((id: string) => {
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  }, []);
  const exportConversation = useCallback((id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    const safe = (c.title || '对话').slice(0, 40).replace(/[\\/:*?"<>|]/g, '_');
    downloadText(safe + '.md', conversationToMarkdown(c));
  }, [conversations]);
  const switchBranch = useCallback((conversationId: string, branchId: string) => {
    if (streamingId) return;
    const c = conversations.find((x) => x.id === conversationId);
    if (!c) return;
    const switched = switchConversationBranch(c, branchId);
    if (!switched) return;
    setConversations((cs) => cs.map((x) => (x.id === conversationId ? switched : x)));
    setActiveConvId(conversationId);
    setMessages(activeConversationMessages(switched));
  }, [conversations, streamingId, setMessages]);
  const forkActiveConversationBeforeMessage = useCallback((messageId: string): boolean => {
    if (streamingId) return false;
    const active = conversations.find((c) => c.id === activeConvId);
    if (!active) return false;
    const forked = forkConversationBeforeMessage(updateActiveConversationMessages(active, messages), messageId, {
      branchId: nextBranchId(),
    });
    if (!forked) return false;
    setConversations((cs) => cs.map((c) => (c.id === activeConvId ? forked.conversation : c)));
    setMessages(forked.messages);
    return true;
  }, [activeConvId, conversations, messages, streamingId, setMessages]);

  return {
    activeConvId,
    convSearch,
    commitRename,
    deleteConversation,
    exportConversation,
    newConversation,
    renameText,
    renamingId,
    setConvSearch,
    setRenameText,
    setRenamingId,
    switchBranch,
    switchConversation,
    forkActiveConversationBeforeMessage,
    togglePin,
    visibleConversations,
  };
}
