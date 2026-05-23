import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getJson, postJson, subscribeRunEvents, openPath, newIdempotencyKey,
  runSubagent, agentChatStream, respondApproval, answerQuestion, cancelRun, getKimiInfo, importUploads, fileToUpload,
  getMe, guestLogin, logout as apiLogout,
  listStoredConversations, saveStoredConversation, deleteStoredConversation, searchStoredConversations, getStoredConversation,
  type SubagentStep, type AuthIdentity,
} from './lib/api';
import { MessageText } from './components/MessageText';
import { extractSuggestions } from './lib/md';
import { convTitle, conversationToMarkdown, isImagePath } from './lib/conversations';
import type { FileOperation, RunEvent, SourceRef, RunSummary, ApprovalState } from './lib/types';
import { MessageBubble } from './components/MessageBubble';
import { ProgressLine, progressStatusFromIcon, type ProgressLineProps } from './components/ProgressLine';
import { PreviewCard } from './components/PreviewCard';
import { ApprovalActions } from './components/ApprovalActions';
import { SourcesFooter } from './components/SourcesFooter';
import { ArtifactCard } from './components/ArtifactCard';
import { TaskStatusBadge } from './components/TaskStatusBadge';
import { Composer, type Recipe, type FileHit, type HistoryRun, type ComposerMeta } from './components/Composer';
import { ToolsPanel } from './components/ToolsPanel';
import { VizPanel } from './components/VizPanel';
import { ConnectorsPanel } from './components/ConnectorsPanel';
import { ArtifactsPanel } from './components/ArtifactsPanel';
import { SchedulesPanel } from './components/SchedulesPanel';
import { ToolCallCard } from './components/ToolCallCard';
import { MessageActions } from './components/MessageActions';
import { CommandPalette, type Command } from './components/CommandPalette';
import { Login } from './components/Login';
import { Settings } from './components/Settings';
import { FilePreview } from './components/FilePreview';

const GUEST_KEY = 'kcw.guest';

interface PendingApproval { id: string; name: string }
interface AssistantMessage {
  id: string;
  role: 'assistant';
  status: string;
  runId?: string;
  text?: string;
  reasoning?: string;
  progress: ProgressLineProps[];
  operations: FileOperation[];
  sources: SourceRef[];
  approvalState: ApprovalState;
  approval?: PendingApproval;
  plan?: { id: string; text: string };
  files?: string[];
  verifying?: boolean;
  question?: { id: string; question: string; options: Array<{ label: string; description?: string }> };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  tools?: Array<{ name: string; args?: unknown; status: string; result?: unknown }>;
}
interface UserMessage { id: string; role: 'user'; text: string }
type Message = UserMessage | AssistantMessage;
interface Conversation { id: string; title: string; messages: Message[]; pinned?: boolean }

const CONV_KEY = 'kcw.conversations.v1';
function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr as Conversation[];
    }
  } catch { /* ignore corrupt storage */ }
  return [{ id: INITIAL_CONV, title: '新对话', messages: [] }];
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STARTERS = [
  '整理工作区里的文档并列出清单',
  '把一个 CSV 文件做成图表',
  '总结这个文件夹里的会议纪要',
  '帮我起草一封邮件草稿',
];

type SidePanel = 'none' | 'tools' | 'viz' | 'connectors' | 'artifacts' | 'schedules';

interface WorkspaceInfo { trustedRoot: string }
interface RecipeRunResponse { runId: string; operations: FileOperation[]; sources: SourceRef[] }

let convSeq = 0;
const nextConvId = () => 'c' + (convSeq += 1);
const INITIAL_CONV = nextConvId();
const PREVIEWABLE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|md|markdown|txt|text|log|csv|tsv|json|yaml|yml|xml|html?|pdf)$/i;
let seq = 0;
const nextId = () => `m${(seq += 1)}`;

export function App() {
  const [trustedRoot, setTrustedRoot] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => loadConversations()[0].messages || []);
  const [panel, setPanel] = useState<SidePanel>('none');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeConvId, setActiveConvId] = useState<string>(() => loadConversations()[0].id);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [convSearch, setConvSearch] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('kcw.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [user, setUser] = useState<AuthIdentity | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Resolve the current identity: a valid stored token, otherwise a previously
  // chosen guest (local) session, otherwise show the login gate.
  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        if (me) setUser(me);
        // Previously chose guest: re-mint a guest token (the old one may be gone
        // after a host restart) so the session still passes the auth gate.
        else if (localStorage.getItem(GUEST_KEY) === '1') {
          const g = await guestLogin();
          if (g) setUser(g);
        }
      } catch { /* host not ready -> stay on gate */ }
      finally { setAuthReady(true); }
    })();
  }, []);

  const doLogout = useCallback(async () => {
    try { await apiLogout(); } catch { /* best-effort */ }
    try { localStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
    setUser(null);
  }, []);

  const continueAsGuest = useCallback(() => {
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* ignore */ }
    void (async () => { const g = await guestLogin(); if (g) setUser(g); })();
  }, []);

  // Initial workspace/recipes/history/model load. Deferred until a user is
  // resolved (authed or guest) because the API now requires a token — fetching
  // before that would just 401.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      try { const ws = await getJson<WorkspaceInfo>('/api/workspace'); setTrustedRoot(ws.trustedRoot); } catch { /* host not ready */ }
      try { const r = await getJson<{ recipes: Recipe[] }>('/api/recipes'); setRecipes(r.recipes || []); } catch { /* ignore */ }
      try { const idx = await getJson<{ runs: RunSummary[] }>('/api/runs/index'); setHistory((idx.runs || []).map((run) => ({ id: run.id, promptPreview: run.promptPreview }))); } catch { /* ignore */ }
      try { const info = await getKimiInfo(); setChatEnabled(Boolean(info.chatEnabled)); if (info.model) { setDefaultModel(info.model); setModels([info.model]); } } catch { /* ignore */ }
    })();
  }, [user]);

  // Keep the active conversation's snapshot in sync so the history rail reflects it.
  useEffect(() => {
    setConversations((cs) => cs.map((c) => (c.id === activeConvId ? { ...c, messages, title: convTitle(messages, c.title) } : c)));
  }, [messages, activeConvId]);

  // Persist conversations to localStorage (offline cache) AND to the host so a
  // signed-in user's history follows their account. Debounced + capped.
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(CONV_KEY, JSON.stringify(conversations.slice(0, 50).map((c) => ({ ...c, messages: c.messages.slice(-60) })))); } catch { /* ignore quota */ }
      if (user) {
        const active = conversations.find((c) => c.id === activeConvId);
        // Only persist conversations that actually have messages — never let a
        // not-yet-hydrated (lazily-loaded) entry overwrite the server copy.
        if (active && active.messages.length > 0) {
          void saveStoredConversation(active.id, { title: active.title, pinned: active.pinned, messages: active.messages.slice(-80) });
        }
      }
    }, 600);
    return () => clearTimeout(t);
  }, [conversations, activeConvId, user]);

  // On sign-in, pull the account's server-side history (one request). Falls back
  // to the localStorage cache when the backend has nothing yet.
  const convSyncedRef = useRef(false);
  useEffect(() => {
    if (!user) { convSyncedRef.current = false; return; }
    if (convSyncedRef.current) return;
    convSyncedRef.current = true;
    void (async () => {
      const remote = await listStoredConversations();
      if (remote.length) {
        const convs: Conversation[] = remote.map((c) => ({
          id: c.id, title: c.title || '新对话', pinned: c.pinned, messages: (c.messages as Message[]) || [],
        }));
        setConversations(convs);
        setActiveConvId(convs[0].id);
        setMessages(convs[0].messages);
      }
    })();
  }, [user]);

  // Apply + persist the theme; open the command palette on Cmd/Ctrl+K.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('kcw.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setCmdkOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  const patchAssistant = useCallback((id: string, patch: (m: AssistantMessage) => AssistantMessage) => {
    setMessages((list) => list.map((m) => (m.id === id && m.role === 'assistant' ? patch(m) : m)));
  }, []);

  // Auto-scroll the timeline to the bottom as messages stream in.
  const timelineRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const copyText = useCallback((t: string) => {
    try { void navigator.clipboard.writeText(t); } catch { /* clipboard unavailable */ }
  }, []);

  const searchFiles = useCallback(async (query: string): Promise<FileHit[]> => {
    try {
      const res = await postJson<{ results: FileHit[] }>('/api/files/search', { trustedRoot, query, maxResults: 8 });
      return res.results || [];
    } catch { return []; }
  }, [trustedRoot]);

  const wireEvents = useCallback((assistantId: string, runId: string) => {
    return subscribeRunEvents(runId, (event: RunEvent) => {
      patchAssistant(assistantId, (m) => {
        const next = { ...m };
        if (event.type === 'progress') next.progress = [...m.progress, { status: progressStatusFromIcon(event.icon), text: event.text || '处理中' }];
        else if (event.type === 'tool_result') { const okMark = event.status === 'succeeded'; next.progress = [...m.progress, { status: okMark ? 'done' : 'failed', text: `${okMark ? '完成' : '失败'}: ${String(event.tool ?? '')}` }]; }
        else if (event.type === 'sources' && Array.isArray(event.items)) next.sources = event.items;
        else if (event.type === 'awaiting_approval') { next.status = 'awaiting_approval'; next.approvalState = 'awaiting'; }
        else if (event.type === 'assistant_end') next.status = event.status === 'failed' ? 'failed' : 'done';
        return next;
      });
    });
  }, [patchAssistant]);

  const uploadAttachments = useCallback(async (files: File[]): Promise<string[]> => {
    if (!files.length) return [];
    try {
      const payload = await Promise.all(files.map((f) => fileToUpload(f)));
      const res = await importUploads(payload, trustedRoot);
      return (res.imported || []).map((it) => it.path || it.relativePath || '').filter(Boolean);
    } catch { return []; }
  }, [trustedRoot]);

  const runRecipeTurn = useCallback(async (assistantId: string, recipeId: string, prompt: string, uploaded: string[]) => {
    try {
      const res = await postJson<RecipeRunResponse>(`/api/recipes/${encodeURIComponent(recipeId)}/run`, {
        trustedRoot, prompt, files: uploaded.map((p) => ({ path: p })), idempotencyKey: newIdempotencyKey('recipe'),
      });
      patchAssistant(assistantId, (m) => ({ ...m, runId: res.runId, operations: res.operations || [], sources: res.sources || [], status: 'awaiting_approval', approvalState: (res.operations || []).length ? 'awaiting' : 'idle' }));
      wireEvents(assistantId, res.runId);
    } catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant, wireEvents]);

  const handleSend = useCallback(async (text: string, meta: ComposerMeta) => {
    const userText = text || (meta.files.length ? `（已上传 ${meta.files.length} 个文件）` : '');
    setMessages((list) => [...list, { id: nextId(), role: 'user', text: userText }]);
    const assistantId = nextId();
    setMessages((list) => [...list, { id: assistantId, role: 'assistant', status: 'thinking', progress: [], operations: [], sources: [], approvalState: 'idle' }]);

    const uploaded = await uploadAttachments(meta.files);
    if (selectedRecipe) { await runRecipeTurn(assistantId, selectedRecipe.id, text, uploaded); return; }

    if (chatEnabled) {
      const prompt = uploaded.length ? `${text}\n\n[已上传文件]\n${uploaded.join('\n')}` : text;
      setStreamingId(assistantId);
      try {
        await agentChatStream(prompt, { trustedRoot, model: meta.model, thinking: meta.thinking, autoApprove, planMode, images: uploaded.filter((p) => isImagePath(p)) }, {
          onStart: (rid) => patchAssistant(assistantId, (m) => ({ ...m, runId: rid })),
          onReasoning: (delta) => patchAssistant(assistantId, (m) => ({ ...m, reasoning: (m.reasoning || '') + delta })),
          onToolCall: (name, args) => patchAssistant(assistantId, (m) => ({ ...m, status: 'running', tools: [...(m.tools || []), { name, args, status: 'running' }] })),
          onToolResult: (name, st, result) => patchAssistant(assistantId, (m) => {
            const tools = [...(m.tools || [])];
            for (let i = tools.length - 1; i >= 0; i -= 1) {
              if (tools[i].name === name && tools[i].status === 'running') { tools[i] = { ...tools[i], status: st, result }; break; }
            }
            return { ...m, tools };
          }),
          onApprovalRequest: (id, name) => patchAssistant(assistantId, (m) => ({ ...m, approval: { id, name } })),
          onFileWritten: (p) => patchAssistant(assistantId, (m) => ({ ...m, files: [...(m.files || []), p].filter((v, i, a) => a.indexOf(v) === i) })),
          onVerifyStart: () => patchAssistant(assistantId, (m) => ({ ...m, verifying: true, progress: [...m.progress, { status: 'running', text: '自检产物中…' }] })),
          onQuestion: (id, question, options) => patchAssistant(assistantId, (m) => ({ ...m, status: 'awaiting_approval', question: { id, question, options } })),
          onPlanProposed: (id, plan) => patchAssistant(assistantId, (m) => ({ ...m, status: 'awaiting_approval', plan: { id, text: plan } })),
          onToken: (delta) => patchAssistant(assistantId, (m) => ({ ...m, status: 'streaming', text: (m.text || '') + delta })),
          onDone: (full) => { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'done', verifying: false, text: full.text || m.text || '', runId: full.runId, usage: full.usage })); },
          onError: (msg) => { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: msg })); },
        });
      } catch (error) { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
      return;
    }

    if (recipes[0]) await runRecipeTurn(assistantId, recipes[0].id, text, uploaded);
    else patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: '通用聊天需要配置 Kimi API（在 .env 设置 KIMI_API_KEY）。' }));
  }, [selectedRecipe, trustedRoot, chatEnabled, autoApprove, planMode, patchAssistant, uploadAttachments, runRecipeTurn]);

  // One-click prompt (starter cards + follow-up suggestion chips).
  const quickSend = useCallback((text: string) => {
    void handleSend(text, { files: [], model: defaultModel, thinking: 'standard' });
  }, [handleSend, defaultModel]);
  // Regenerate: re-send the user message that preceded this assistant turn.
  const regenerate = useCallback((assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'user' && m.text) { quickSend(m.text); return; }
    }
  }, [messages, quickSend]);

  // Edit a previously sent user message: drop it and everything after, then
  // resend the edited text (the assistant re-answers from that point).
  const beginEdit = useCallback((messageId: string, text: string) => {
    if (streamingId) return;
    setEditingMsgId(messageId);
    setEditText(text);
  }, [streamingId]);
  const submitEdit = useCallback((messageId: string) => {
    const text = editText.trim();
    setEditingMsgId(null);
    if (!text || streamingId) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    setMessages(messages.slice(0, idx));
    void handleSend(text, { files: [], model: defaultModel, thinking: 'standard' });
  }, [editText, messages, streamingId, handleSend, defaultModel]);

  // Click a produced file: preview previewable types inline, otherwise open it
  // with the system app.
  const openOrPreview = useCallback((p: string) => {
    if (PREVIEWABLE_RE.test(p)) setPreviewPath(p);
    else void openPath(p);
  }, []);

  const respondToApproval = useCallback((messageId: string, approvalId: string, decision: 'once' | 'session' | 'reject') => {
    void respondApproval(approvalId, decision);
    patchAssistant(messageId, (m) => ({ ...m, approval: undefined }));
  }, [patchAssistant]);

  // Plan mode: approving the plan resolves the same approval promise with 'once'
  // (run), "keep planning" resolves with 'reject' so the agent revises and re-proposes.
  const respondToPlan = useCallback((messageId: string, planId: string, approve: boolean) => {
    void respondApproval(planId, approve ? 'once' : 'reject');
    patchAssistant(messageId, (m) => ({ ...m, plan: undefined, status: approve ? 'applying' : 'running' }));
  }, [patchAssistant]);

  // AskUserQuestion: post the chosen option back over the approvals channel and resume.
  const respondToQuestion = useCallback((messageId: string, id: string, answer: string) => {
    void answerQuestion(id, answer);
    patchAssistant(messageId, (m) => ({ ...m, question: undefined, status: 'running' }));
  }, [patchAssistant]);

  // Stop button: cancel the active streaming run by its runId.
  const stopStreaming = useCallback(() => {
    if (!streamingId) return;
    const msg = messages.find((m) => m.id === streamingId && m.role === 'assistant') as AssistantMessage | undefined;
    if (msg && msg.runId) void cancelRun(msg.runId);
    setStreamingId(null);
  }, [streamingId, messages]);

  const handleRunSubagent = useCallback(async (goal: string, steps: SubagentStep[]) => {
    if (!steps.length) return;
    setMessages((list) => [...list, { id: nextId(), role: 'user', text: goal || `运行子任务 (${steps.length} 步)` }]);
    const assistantId = nextId();
    setMessages((list) => [...list, { id: assistantId, role: 'assistant', status: 'thinking', progress: [], operations: [], sources: [], approvalState: 'idle' }]);
    try { const res = await runSubagent(goal, steps, trustedRoot); wireEvents(assistantId, res.runId); patchAssistant(assistantId, (m) => ({ ...m, runId: res.runId, status: res.ok ? 'done' : 'failed' })); }
    catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant, wireEvents]);

  const handleApprove = useCallback(async (message: AssistantMessage) => {
    try {
      await postJson('/api/file-ops/apply', { trustedRoot, operations: message.operations, idempotencyKey: newIdempotencyKey('apply') });
      patchAssistant(message.id, (m) => ({ ...m, approvalState: 'approved', status: 'done' }));
    } catch (error) { patchAssistant(message.id, (m) => ({ ...m, text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant]);

  const empty = useMemo(() => messages.length === 0, [messages]);
  const visibleConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const filtered = q
      ? conversations.filter((c) => (c.title || '').toLowerCase().includes(q) || c.messages.some((m) => (m.text || '').toLowerCase().includes(q)))
      : conversations;
    return [...filtered].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }, [conversations, convSearch]);
  const togglePanel = useCallback((next: SidePanel) => { setPanel((current) => (current === next ? 'none' : next)); }, []);
  const newConversation = useCallback(() => {
    if (streamingId) return;
    const id = nextConvId();
    setConversations((cs) => [{ id, title: '新对话', messages: [] }, ...cs]);
    setActiveConvId(id);
    setMessages([]);
    setSelectedRecipe(null);
  }, [streamingId]);
  const switchConversation = useCallback((id: string) => {
    if (id === activeConvId || streamingId) return;
    const c = conversations.find((x) => x.id === id);
    setActiveConvId(id);
    setMessages(c ? c.messages : []);
    // Lazily hydrate messages for entries pulled in via server-side search.
    if (user && c && c.messages.length === 0) {
      void (async () => {
        const full = await getStoredConversation(id);
        const msgs = (full && Array.isArray(full.messages) ? full.messages : []) as Message[];
        if (msgs.length) {
          setMessages((cur) => (cur.length === 0 ? msgs : cur));
          setConversations((cs) => cs.map((x) => (x.id === id ? { ...x, messages: msgs } : x)));
        }
      })();
    }
  }, [activeConvId, streamingId, conversations, user]);

  // Server-side search: pull matching (not-yet-loaded) conversations into the
  // rail as lightweight entries; switching one hydrates its messages on demand.
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
      setMessages(remaining[0].messages);
    }
  }, [conversations, activeConvId, streamingId, user]);
  const togglePin = useCallback((id: string) => {
    setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  }, []);
  const exportConversation = useCallback((id: string) => {
    const c = conversations.find((x) => x.id === id);
    if (!c) return;
    const safe = (c.title || '对话').slice(0, 40).replace(/[\\/:*?"<>|]/g, '_');
    downloadText(safe + '.md', conversationToMarkdown(c));
  }, [conversations]);

  const commands = useMemo<Command[]>(() => [
    { id: 'new', label: '新建对话', run: () => newConversation() },
    { id: 'theme', label: theme === 'dark' ? '切换到浅色' : '切换到深色', run: () => toggleTheme() },
    { id: 'plan', label: planMode ? '关闭计划模式' : '开启计划模式', run: () => setPlanMode((v) => !v) },
    { id: 'auto', label: autoApprove ? '关闭自动批准' : '开启自动批准', run: () => setAutoApprove((v) => !v) },
    { id: 'p-tools', label: '面板：工具', run: () => setPanel('tools') },
    { id: 'p-viz', label: '面板：可视化', run: () => setPanel('viz') },
    { id: 'p-conn', label: '面板：连接器', run: () => setPanel('connectors') },
    { id: 'p-art', label: '面板：产物', run: () => setPanel('artifacts') },
    { id: 'p-sched', label: '面板：定时任务', run: () => setPanel('schedules') },
    { id: 'settings', label: 'API 设置', run: () => setSettingsOpen(true) },
    { id: 'logout', label: '退出登录', run: () => void doLogout() },
  ], [theme, planMode, autoApprove, newConversation, toggleTheme, doLogout]);

  if (!authReady) {
    return <div className="auth-boot"><span className="brand-dot" aria-hidden="true" /> 正在启动 Kimi Cowork…</div>;
  }
  if (!user) {
    return <Login onAuthed={(u) => setUser(u)} onGuest={continueAsGuest} />;
  }

  return (
    <div className="app-shell">
      <aside className="conversation-rail">
        <button type="button" className="new-conv-btn" onClick={newConversation}>＋ 新建对话</button>
        <input className="conv-search" placeholder="搜索对话…" value={convSearch} onChange={(e) => setConvSearch(e.target.value)} />
        <div className="conv-list">
          {visibleConversations.map((c) => (
            <div key={c.id} className={`conv-item${c.id === activeConvId ? ' is-active' : ''}${c.pinned ? ' is-pinned' : ''}`}>
              {renamingId === c.id ? (
                <input
                  className="conv-rename"
                  autoFocus
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') setRenamingId(null); }}
                  onBlur={commitRename}
                />
              ) : (
                <>
                  <button type="button" className="conv-title" onClick={() => switchConversation(c.id)}>{c.pinned ? '📌 ' : ''}{c.title || '新对话'}</button>
                  <button type="button" className="conv-act" title={c.pinned ? '取消置顶' : '置顶'} onClick={() => togglePin(c.id)}>{c.pinned ? '☆' : '⤒'}</button>
                  <button type="button" className="conv-act" title="导出 Markdown" onClick={() => exportConversation(c.id)}>⤓</button>
                  <button type="button" className="conv-act" title="重命名" onClick={() => { setRenamingId(c.id); setRenameText(c.title || ''); }}>✎</button>
                  <button type="button" className="conv-act" title="删除" onClick={() => deleteConversation(c.id)}>✕</button>
                </>
              )}
            </div>
          ))}
          {visibleConversations.length === 0 && <div className="conv-empty">没有匹配的对话</div>}
        </div>
      </aside>
      <div className="app-content">
      <header className="app-header">
        <span className="brand-dot" aria-hidden="true" />
        <h1>Kimi Cowork</h1>
        <span className="workspace-path">{trustedRoot}</span>
        <nav className="header-actions">
          <button type="button" onClick={() => setCmdkOpen(true)} title="命令面板 (Ctrl/Cmd+K)">⌘K</button>
          <button type="button" onClick={toggleTheme} title="深色 / 浅色">{theme === 'dark' ? '☀' : '🌙'}</button>
          <button type="button" className={planMode ? 'is-active' : ''} onClick={() => setPlanMode((v) => !v)} title="开启后 Kimi 先只读研究并提交计划草案，待你批准后再执行写操作">{planMode ? '计划模式·开' : '计划模式·关'}</button>
          <button type="button" className={autoApprove ? 'is-active' : ''} onClick={() => setAutoApprove((v) => !v)} title="开启后自动批准文件改动；高风险操作（命令/外部连接器）仍需逐次确认">{autoApprove ? '自动批准·开' : '自动批准·关'}</button>
          <button type="button" className={panel === 'tools' ? 'is-active' : ''} onClick={() => togglePanel('tools')}>工具</button>
          <button type="button" className={panel === 'viz' ? 'is-active' : ''} onClick={() => togglePanel('viz')}>可视化</button>
          <button type="button" className={panel === 'connectors' ? 'is-active' : ''} onClick={() => togglePanel('connectors')}>连接器</button>
          <button type="button" className={panel === 'artifacts' ? 'is-active' : ''} onClick={() => togglePanel('artifacts')}>产物</button>
          <button type="button" className={panel === 'schedules' ? 'is-active' : ''} onClick={() => togglePanel('schedules')}>定时任务</button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="API 设置">⚙ 设置</button>
          <span className="header-user" title={`租户 ${user.tenantId}`}>{user.username}</span>
          <button type="button" className="header-logout" onClick={() => void doLogout()} title="退出登录">退出</button>
        </nav>
      </header>

      <main className="timeline" role="log" ref={timelineRef}>
        {empty && (
          <div className="empty-state">
            <strong>Kimi Cowork</strong>
            <p>直接和 Kimi 对话即可，它能读写工作区文件、运行代码。需要文件操作时会先请你批准。</p>
            <div className="starter-chips">
              {STARTERS.map((sug) => (
                <button key={sug} type="button" className="starter-chip" onClick={() => quickSend(sug)}>{sug}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => message.role === 'user' ? (
          editingMsgId === message.id ? (
            <div key={message.id} className="user-edit">
              <textarea
                className="user-edit-area"
                value={editText}
                autoFocus
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(message.id); }
                  else if (e.key === 'Escape') { setEditingMsgId(null); }
                }}
              />
              <div className="user-edit-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditingMsgId(null)}>取消</button>
                <button type="button" className="btn-primary" onClick={() => submitEdit(message.id)}>重新发送</button>
              </div>
            </div>
          ) : (
            <MessageBubble key={message.id} role="user">
              <span className="user-msg-text">{message.text}</span>
              {!streamingId && (
                <button type="button" className="user-edit-btn" title="编辑并重新发送" onClick={() => beginEdit(message.id, message.text)}>✎ 编辑</button>
              )}
            </MessageBubble>
          )
        ) : (
          <MessageBubble key={message.id} role="assistant" status="" runId={message.runId}>
            {(message.status === 'thinking' || message.status === 'streaming') && !message.text && (
              <div className="turn-status">{message.reasoning ? '思考中' : '正在响应'}<span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></div>
            )}
            {message.reasoning && (
              <details className="reasoning" open={!message.text}>
                <summary>思考过程</summary>
                <div className="reasoning-body">{message.reasoning}</div>
              </details>
            )}
            {message.progress.map((p, i) => <ProgressLine key={i} {...p} />)}
            {message.tools && message.tools.length > 0 && (
              <div className="toolcalls">
                {message.tools.map((t, i) => <ToolCallCard key={i} call={t} />)}
              </div>
            )}
            {message.plan && (
              <div className="plan-card">
                <div className="plan-card-head">计划待批准</div>
                <MessageText text={message.plan.text} trustedRoot={trustedRoot} />
                <div className="plan-card-actions">
                  <button type="button" className="plan-approve" onClick={() => respondToPlan(message.id, message.plan!.id, true)}>批准并执行</button>
                  <button type="button" onClick={() => respondToPlan(message.id, message.plan!.id, false)}>继续完善</button>
                </div>
              </div>
            )}
            {message.question && (
              <div className="question-card">
                <div className="question-q">{message.question.question}</div>
                <div className="question-options">
                  {message.question.options.length > 0 ? message.question.options.map((opt, i) => (
                    <button key={i} type="button" onClick={() => respondToQuestion(message.id, message.question!.id, opt.label)}>
                      <strong>{opt.label}</strong>
                      {opt.description && <span>{opt.description}</span>}
                    </button>
                  )) : (
                    <button type="button" onClick={() => respondToQuestion(message.id, message.question!.id, '继续')}>继续</button>
                  )}
                </div>
              </div>
            )}
            {message.approval && (
              <div className="approval-bar">
                <span className="approval-q">需要批准操作：<code>{message.approval.name}</code></span>
                <div className="approval-actions">
                  <button type="button" onClick={() => respondToApproval(message.id, message.approval!.id, 'once')}>本次批准</button>
                  <button type="button" onClick={() => respondToApproval(message.id, message.approval!.id, 'session')}>本会话批准</button>
                  <button type="button" className="reject" onClick={() => respondToApproval(message.id, message.approval!.id, 'reject')}>拒绝</button>
                </div>
              </div>
            )}
            {message.text && (() => {
              const parsed = extractSuggestions(message.text);
              return (
                <>
                  {parsed.text && <MessageText text={parsed.text} trustedRoot={trustedRoot} />}
                  {message.id === streamingId && <span className="type-caret" aria-hidden="true" />}
                  {parsed.suggestions.length > 0 && message.status === 'done' && (
                    <div className="suggestion-chips">
                      {parsed.suggestions.map((sug, i) => (
                        <button key={i} type="button" className="suggestion-chip" onClick={() => quickSend(sug)}>{sug}</button>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
            {message.files && message.files.length > 0 && (
              <div className="file-cards">
                {message.files.map((fp, i) => (
                  <ArtifactCard key={`${fp}-${i}`} file={{ path: `${trustedRoot}/${fp}`, relativePath: fp }} metadata={fp} onOpen={(p) => openOrPreview(p)} />
                ))}
              </div>
            )}
            {message.operations.length > 0 && <PreviewCard operations={message.operations} />}
            {message.operations.length > 0 && (
              <ApprovalActions runId={message.runId || ''} operations={message.operations} approvalState={message.approvalState} onApprove={() => void handleApprove(message)} onReject={() => patchAssistant(message.id, (m) => ({ ...m, approvalState: 'rejected' }))} />
            )}
            <SourcesFooter sources={message.sources} />
            {message.status === 'done' && message.text && (
              <MessageActions onCopy={() => copyText(extractSuggestions(message.text || '').text)} onRegenerate={() => regenerate(message.id)} />
            )}
            {message.usage && message.usage.total_tokens ? <div className="usage-line">用量 {message.usage.total_tokens} tokens</div> : null}
            {message.operations.length > 0 && <TaskStatusBadge runId={message.runId} status={message.status} />}
            {message.approvalState === 'approved' && (
              <ArtifactCard file={{ path: `${trustedRoot}/.KimiCowork/artifacts` }} metadata=".KimiCowork/artifacts" onOpen={(p) => void openPath(p)} />
            )}
          </MessageBubble>
        ))}
      </main>

      <footer className="composer-dock">
        {streamingId && (
          <div className="stop-bar"><button type="button" className="stop-btn" onClick={stopStreaming}>■ 停止生成</button></div>
        )}
        {selectedRecipe && <div className="recipe-chip">模板：{selectedRecipe.name} <button type="button" onClick={() => setSelectedRecipe(null)}>清除</button></div>}
        <Composer recipes={recipes} historyRuns={history} searchFiles={searchFiles} models={models} defaultModel={defaultModel} slashCommands={commands} onSend={(t, meta) => void handleSend(t, meta)} onPickTemplate={(r) => setSelectedRecipe(r)} />
      </footer>
      </div>

      {panel !== 'none' && (
        <aside className="side-drawer">
          <button type="button" className="drawer-close" aria-label="关闭" onClick={() => setPanel('none')}>×</button>
          {panel === 'tools' && <ToolsPanel trustedRoot={trustedRoot} onRunPlan={(g, s) => void handleRunSubagent(g, s)} />}
          {panel === 'viz' && <VizPanel trustedRoot={trustedRoot} />}
          {panel === 'connectors' && <ConnectorsPanel trustedRoot={trustedRoot} />}
          {panel === 'artifacts' && <ArtifactsPanel trustedRoot={trustedRoot} />}
          {panel === 'schedules' && <SchedulesPanel />}
        </aside>
      )}
      {cmdkOpen && <CommandPalette commands={commands} onClose={() => setCmdkOpen(false)} />}
      {previewPath && <FilePreview path={previewPath} trustedRoot={trustedRoot} onClose={() => setPreviewPath(null)} />}
      {settingsOpen && (
        <Settings
          username={user.username}
          tenantId={user.tenantId}
          theme={theme}
          onSetTheme={(t) => setTheme(t)}
          onLogout={() => { setSettingsOpen(false); void doLogout(); }}
          onClose={() => setSettingsOpen(false)}
          onSaved={(info) => {
            setChatEnabled(Boolean(info.chatEnabled));
            if (info.model) { setDefaultModel(info.model); setModels([info.model]); }
          }}
        />
      )}
    </div>
  );
}
