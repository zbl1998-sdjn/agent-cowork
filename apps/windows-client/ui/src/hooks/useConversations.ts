// useConversations(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:封装多会话的全部状态与副作用——加载/创建/切换/改名/删除会话、与 host 会话 API 同步、本地缓存。
//       让 App 只编排、组件只渲染(plan/00:数据逻辑进 hooks)。依赖:lib/api + lib/conversations 纯逻辑。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  activeConversationMessages,
  compactConversationForStorage,
  forkConversationBeforeMessage,
  shouldApplyHydratedMessages,
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
  if (!initialConversationsRef.current) {
    const loaded = loadConversations();
    initialConversationsRef.current = loaded.length ? loaded : [{ id: nextConvId(), title: '新对话', messages: [] }];
  }
  const initialConversations = initialConversationsRef.current;

  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [activeConvId, setActiveConvId] = useState<string>(initialConversations[0]?.id || nextConvId());
  // 供异步补水回调读取「最新」active 会话:闭包里的 activeConvId 是发起时的旧值,
  // 迟到结果必须对照当前值判断是否还该落地(防串话,见 shouldApplyHydratedMessages)。
  const activeConvIdRef = useRef(activeConvId);
  activeConvIdRef.current = activeConvId;
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
      } catch { /* 本地配额不足时跳过缓存写入 */ }
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
        const remoteConvs: Conversation[] = remote.map((c) => ({
          id: c.id,
          title: c.title || '新对话',
          pinned: c.pinned,
          messages: (c.messages as Message[]) || [],
          activeBranchId: c.activeBranchId,
          branches: c.branches as Conversation['branches'],
        }));
        // 合并而非覆盖:按 id 去重并集,本地独有会话(未同步/他端建的)保留,同 id 取消息更多者;
        // 避免登录后远端静默顶掉本地历史。也不强切当前 active 会话(保持用户正在看的那个)。
        setConversations((local) => {
          const byId = new Map<string, Conversation>(local.map((c) => [c.id, c]));
          for (const r of remoteConvs) {
            const existing = byId.get(r.id);
            if (!existing || r.messages.length >= existing.messages.length) byId.set(r.id, r);
          }
          return [...byId.values()];
        });
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
          // 列表缓存回写到「请求的那个会话」总是安全的;但当前视图(messages)只在
          // 用户仍停留在该会话且视图为空时才落地,否则迟到补水会把旧会话内容
          // 灌进用户已新建/切换的会话(串话+被回写 effect 持久化)。
          setConversations((cs) => cs.map((x) => (x.id === id ? hydrated : x)));
          setMessages((cur) => (
            shouldApplyHydratedMessages({ requestedId: id, activeConvId: activeConvIdRef.current, currentMessageCount: cur.length })
              ? activeMessages
              : cur
          ));
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
      const nextActive = remaining[0];
      if (!nextActive) return;
      setActiveConvId(nextActive.id);
      setMessages(activeConversationMessages(nextActive));
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
