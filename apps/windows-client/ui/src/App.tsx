import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  agentChatStream, cancelRun, fileToUpload, getJson, getKimiInfo, getMe, guestLogin, importUploads,
  logout as apiLogout, newIdempotencyKey, openPath, postJson, refinePrompt, runSubagent, subscribeRunEvents,
  type AuthIdentity, type SubagentStep,
} from './lib/api';
import { buildAgentChatStreamOptions, hasSessionModelAccess, mergeTodoUpdate, reconcileChatEnabled, reduceAssistantRunEvent } from './lib/app-logic';
import { AUTO_CLARIFY_KEY, GUEST_KEY, loadConversations, nextMessageId, PREVIEWABLE_RE, STARTERS } from './lib/app-constants';
import type { AssistantMessage, Message, RecipeRunResponse, SidePanel, WorkspaceInfo } from './lib/app-types';
import { ONBOARDING_DONE_KEY } from './lib/onboarding';
import type { RunEvent, RunSummary } from './lib/types';
import { isImagePath } from './lib/conversations';
import { Login } from './components/Login';
import { ConversationRail } from './components/ConversationRail';
import { AppHeader } from './components/AppHeader';
import { Timeline } from './components/chat/Timeline';
import { AppComposerDock } from './components/AppComposerDock';
import { AppSidePanel } from './components/AppSidePanel';
import { AppOverlays } from './components/AppOverlays';
import type { Command } from './components/CommandPalette';
import type { ComposerMeta, FileHit, HistoryRun, Recipe } from './components/Composer';
import { useStickToBottom } from './hooks/useStickToBottom';
import { useConversations } from './hooks/useConversations';
export function App() {
  const [trustedRoot, setTrustedRoot] = useState('');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => loadConversations()[0].messages || []);
  const [panel, setPanel] = useState<SidePanel>('none');
  const [models, setModels] = useState<string[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [defaultProvider, setDefaultProvider] = useState('kimi-api');
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoClarify, setAutoClarify] = useState(() => {
    try { return localStorage.getItem(AUTO_CLARIFY_KEY) === '1'; } catch { return false; }
  });
  const [planMode, setPlanMode] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { return localStorage.getItem('kcw.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [user, setUser] = useState<AuthIdentity | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_DONE_KEY) !== '1'; } catch { return true; }
  });
  useEffect(() => {
    void (async () => {
      try {
        const me = await getMe();
        if (me) setUser(me);
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
  const completeOnboarding = useCallback(() => {
    try { localStorage.setItem(ONBOARDING_DONE_KEY, '1'); } catch { /* ignore */ }
    setOnboardingOpen(false);
  }, []);
  const openSettingsFromOnboarding = useCallback(() => {
    completeOnboarding();
    setSettingsOpen(true);
  }, [completeOnboarding]);
  const continueAsGuest = useCallback(() => {
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* ignore */ }
    void (async () => { const g = await guestLogin(); if (g) setUser(g); })();
  }, []);
  useEffect(() => {
    if (!user) return;
    void (async () => {
      try { const ws = await getJson<WorkspaceInfo>('/api/workspace'); setTrustedRoot(ws.trustedRoot); } catch { /* host not ready */ }
      try { const r = await getJson<{ recipes: Recipe[] }>('/api/recipes'); setRecipes(r.recipes || []); } catch { /* ignore */ }
      try {
        const idx = await getJson<{ runs: RunSummary[] }>('/api/runs/index');
        setHistory((idx.runs || []).map((run) => ({ id: run.id, promptPreview: run.promptPreview })));
      } catch { /* ignore */ }
      try {
        const info = await getKimiInfo();
        setChatEnabled(Boolean(info.chatEnabled));
        setDefaultProvider(info.provider || 'kimi-api');
        setDefaultBaseUrl(info.baseUrl || '');
        if (info.model) { setDefaultModel(info.model); setModels([info.model]); }
      } catch { /* ignore */ }
    })();
  }, [user]);

  const conversations = useConversations({ messages, setMessages, setSelectedRecipe, streamingId, user });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('kcw.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem(AUTO_CLARIFY_KEY, autoClarify ? '1' : '0'); } catch { /* ignore */ }
  }, [autoClarify]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setCmdkOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleTheme = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  const togglePanel = useCallback((next: SidePanel) => setPanel((current) => (current === next ? 'none' : next)), []);
  const patchAssistant = useCallback((id: string, patch: (m: AssistantMessage) => AssistantMessage) => {
    setMessages((list) => list.map((m) => (m.id === id && m.role === 'assistant' ? patch(m) : m)));
  }, []);
  const { containerRef: timelineRef, isAtBottom, hasNewContent, scrollToBottom } = useStickToBottom(messages, conversations.activeConvId);

  const copyText = useCallback((t: string) => {
    try { void navigator.clipboard.writeText(t); } catch { /* clipboard unavailable */ }
  }, []);
  const searchFiles = useCallback(async (query: string): Promise<FileHit[]> => {
    try {
      const res = await postJson<{ results: FileHit[] }>('/api/files/search', { trustedRoot, query, maxResults: 8 });
      return res.results || [];
    } catch { return []; }
  }, [trustedRoot]);
  const handleRefinePrompt = useCallback((prompt: string) => refinePrompt(prompt, { trustedRoot }), [trustedRoot]);
  const wireEvents = useCallback((assistantId: string, runId: string) => subscribeRunEvents(runId, (event: RunEvent) => {
    patchAssistant(assistantId, (m) => reduceAssistantRunEvent(m, event));
  }), [patchAssistant]);
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
      patchAssistant(assistantId, (m) => ({ ...m, runId: res.runId, operations: res.operations || [], fileOperationApprovalId: res.fileOperationApprovalId || null, sources: res.sources || [], status: 'awaiting_approval', approvalState: (res.operations || []).length ? 'awaiting' : 'idle' }));
      wireEvents(assistantId, res.runId);
    } catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant, wireEvents]);

  const handleSend = useCallback(async (text: string, meta: ComposerMeta) => {
    const userText = text || (meta.files.length ? `（已上传 ${meta.files.length} 个文件）` : '');
    setMessages((list) => [...list, { id: nextMessageId(), role: 'user', text: userText }]);
    const assistantId = nextMessageId();
    setMessages((list) => [...list, { id: assistantId, role: 'assistant', status: 'thinking', progress: [], operations: [], sources: [], approvalState: 'idle' }]);
    const uploaded = await uploadAttachments(meta.files);
    if (selectedRecipe) { await runRecipeTurn(assistantId, selectedRecipe.id, text, uploaded); return; }

    const sessionModelAccess = hasSessionModelAccess(meta.modelConfig);
    let enabled = chatEnabled || sessionModelAccess;
    if (!enabled) {
      try {
        const reconciled = reconcileChatEnabled(chatEnabled, await getKimiInfo());
        enabled = reconciled.enabled;
        if (reconciled.shouldUpdateState) setChatEnabled(true);
      } catch { /* host unreachable */ }
    }
    if (!enabled) {
      if (recipes[0]) await runRecipeTurn(assistantId, recipes[0].id, text, uploaded);
      else patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: '通用聊天需要配置 Kimi API（在 .env 设置 KIMI_API_KEY）。' }));
      return;
    }

    const prompt = uploaded.length ? `${text}\n\n[已上传文件]\n${uploaded.join('\n')}` : text;
    setStreamingId(assistantId);
    try {
      await agentChatStream(prompt, buildAgentChatStreamOptions({
        trustedRoot,
        model: meta.model,
        modelConfig: meta.modelConfig,
        thinking: meta.thinking,
        autoApprove,
        planMode,
        images: uploaded.filter((p) => isImagePath(p)),
      }), {
        onStart: (rid) => patchAssistant(assistantId, (m) => ({ ...m, runId: rid })),
        onReasoning: (delta) => patchAssistant(assistantId, (m) => ({ ...m, reasoning: (m.reasoning || '') + delta })),
        onToolCall: (name, args) => patchAssistant(assistantId, (m) => ({ ...m, status: 'running', tools: [...(m.tools || []), { name, args, status: 'running', startedAt: Date.now() }] })),
        onToolResult: (name, st, result, meta) => patchAssistant(assistantId, (m) => {
          const tools = [...(m.tools || [])];
          const finishedAt = Date.now();
          const error = result && typeof result === 'object' && 'error' in result ? String((result as { error?: unknown }).error || '') : undefined;
          for (let i = tools.length - 1; i >= 0; i -= 1) {
            const current = tools[i];
            if (!current || current.name !== name || current.status !== 'running') continue;
            const rawStartedAt = current.startedAt;
            const startedAtMs = typeof rawStartedAt === 'number' && Number.isFinite(rawStartedAt) ? rawStartedAt : finishedAt;
            tools[i] = { ...current, status: st, result, finishedAt, durationMs: meta?.durationMs ?? Math.max(0, finishedAt - startedAtMs), ...(error ? { error } : {}) };
            break;
          }
          return { ...m, tools };
        }),
        onTodoSnapshot: (todos) => patchAssistant(assistantId, (m) => ({ ...m, todos })),
        onTodoUpdate: (todo) => patchAssistant(assistantId, (m) => ({ ...m, todos: mergeTodoUpdate(m.todos, todo) })),
        onApprovalRequest: (id, name) => patchAssistant(assistantId, (m) => ({ ...m, approval: { id, name } })),
        onFileWritten: (p) => patchAssistant(assistantId, (m) => ({ ...m, files: [...(m.files || []), p].filter((v, i, a) => a.indexOf(v) === i) })),
        onVerifyStart: () => patchAssistant(assistantId, (m) => ({ ...m, verifying: true, progress: [...m.progress, { status: 'running', text: '自检产物中…' }] })),
        onQuestion: (id, question, options) => patchAssistant(assistantId, (m) => ({ ...m, status: 'awaiting_approval', question: { id, question, options } })),
        onPlanProposed: (id, plan) => patchAssistant(assistantId, (m) => ({ ...m, status: 'awaiting_approval', plan: { id, text: plan } })),
        onToken: (delta) => patchAssistant(assistantId, (m) => ({ ...m, status: 'streaming', text: (m.text || '') + delta })),
        onDone: (full) => { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'done', verifying: false, text: full.text || m.text || '', runId: full.runId || m.runId, usage: full.usage || m.usage })); },
        onCancelled: (full) => { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'cancelled', verifying: false, text: full.text || m.text || '已取消本轮运行。可点击继续发起下一轮。', runId: full.runId || m.runId, usage: full.usage || m.usage })); },
        onError: (msg) => { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: msg })); },
      });
    } catch (error) { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
  }, [autoApprove, chatEnabled, patchAssistant, planMode, recipes, runRecipeTurn, selectedRecipe, trustedRoot, uploadAttachments]);

  const quickSend = useCallback((text: string) => void handleSend(text, { files: [], model: defaultModel, thinking: 'standard' }), [handleSend, defaultModel]);
  const regenerate = useCallback((assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const text = messages[i].role === 'user' ? messages[i].text : '';
      if (text) { quickSend(text); return; }
    }
  }, [messages, quickSend]);
  const beginEdit = useCallback((messageId: string, text: string) => {
    if (!streamingId) { setEditingMsgId(messageId); setEditText(text); }
  }, [streamingId]);
  const submitEdit = useCallback((messageId: string) => {
    const text = editText.trim();
    setEditingMsgId(null);
    if (!text || streamingId) return;
    if (conversations.forkActiveConversationBeforeMessage(messageId)) {
      void handleSend(text, { files: [], model: defaultModel, thinking: 'standard' });
    }
  }, [conversations, editText, streamingId, handleSend, defaultModel]);
  const openOrPreview = useCallback((p: string) => { if (PREVIEWABLE_RE.test(p)) setPreviewPath(p); else void openPath(p); }, []);
  const stopStreaming = useCallback(() => {
    if (!streamingId) return;
    const msg = messages.find((m) => m.id === streamingId && m.role === 'assistant') as AssistantMessage | undefined;
    if (msg && msg.runId) void cancelRun(msg.runId);
    patchAssistant(streamingId, (m) => ({ ...m, status: 'cancelled', verifying: false, text: m.text || '正在取消本轮运行。可点击继续发起下一轮。' }));
    setStreamingId(null);
  }, [streamingId, messages, patchAssistant]);
  const handleRunSubagent = useCallback(async (goal: string, steps: SubagentStep[]) => {
    if (!steps.length) return;
    setMessages((list) => [...list, { id: nextMessageId(), role: 'user', text: goal || `运行子任务 (${steps.length} 步)` }]);
    const assistantId = nextMessageId();
    setMessages((list) => [...list, { id: assistantId, role: 'assistant', status: 'thinking', progress: [], operations: [], sources: [], approvalState: 'idle' }]);
    try { const res = await runSubagent(goal, steps, trustedRoot); wireEvents(assistantId, res.runId); patchAssistant(assistantId, (m) => ({ ...m, runId: res.runId, status: res.ok ? 'done' : 'failed' })); }
    catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant, wireEvents]);
  const handleApprove = useCallback(async (message: AssistantMessage) => {
    try {
      const applied = await postJson<{ rollbackApprovalId?: string | null }>('/api/file-ops/apply', {
        trustedRoot,
        operations: message.operations,
        fileOperationApprovalId: message.fileOperationApprovalId,
        idempotencyKey: newIdempotencyKey('apply'),
      });
      patchAssistant(message.id, (m) => ({ ...m, rollbackApprovalId: applied.rollbackApprovalId || null, approvalState: 'approved', status: 'done' }));
    } catch (error) { patchAssistant(message.id, (m) => ({ ...m, text: (error as Error).message })); }
  }, [trustedRoot, patchAssistant]);

  const commands = useMemo<Command[]>(() => [
    { id: 'new', label: '新建对话', run: conversations.newConversation }, { id: 'theme', label: theme === 'dark' ? '切换到浅色' : '切换到深色', run: toggleTheme }, { id: 'plan', label: planMode ? '关闭计划模式' : '开启计划模式', run: () => setPlanMode((v) => !v) },
    { id: 'auto', label: autoApprove ? '关闭自动批准' : '开启自动批准', run: () => setAutoApprove((v) => !v) }, { id: 'auto-clarify', label: autoClarify ? '关闭发送前澄清' : '开启发送前澄清', run: () => setAutoClarify((v) => !v) }, { id: 'p-tools', label: '面板：工具', run: () => setPanel('tools') }, { id: 'p-viz', label: '面板：可视化', run: () => setPanel('viz') },
    { id: 'p-conn', label: '面板：连接器', run: () => setPanel('connectors') }, { id: 'p-art', label: '面板：产物', run: () => setPanel('artifacts') }, { id: 'p-sched', label: '面板：定时任务', run: () => setPanel('schedules') },
    { id: 'p-memory', label: '面板：记忆', run: () => setPanel('memory') }, { id: 'p-observe', label: '面板：成本 / 可观测', run: () => setPanel('observability') },
    { id: 'settings', label: 'API 设置', run: () => setSettingsOpen(true) }, { id: 'logout', label: '退出登录', run: () => void doLogout() },
  ], [autoApprove, autoClarify, conversations.newConversation, doLogout, planMode, theme, toggleTheme]);

  if (!authReady) return <div className="auth-boot"><span className="brand-dot" aria-hidden="true" /> 正在启动 Agent Cowork…</div>;
  if (!user) return <Login onAuthed={(u) => setUser(u)} onGuest={continueAsGuest} />;

  return (
    <div className="app-shell">
      <ConversationRail activeConvId={conversations.activeConvId} convSearch={conversations.convSearch} conversations={conversations.visibleConversations} renamingId={conversations.renamingId} renameText={conversations.renameText} onCommitRename={conversations.commitRename} onDelete={conversations.deleteConversation} onExport={conversations.exportConversation} onNew={conversations.newConversation} onRenameText={conversations.setRenameText} onSearch={conversations.setConvSearch} onSetRenamingId={conversations.setRenamingId} onSwitch={conversations.switchConversation} onSwitchBranch={conversations.switchBranch} onTogglePin={conversations.togglePin} />
      <div className="app-content">
        <AppHeader autoApprove={autoApprove} panel={panel} planMode={planMode} theme={theme} trustedRoot={trustedRoot} user={user} onLogout={() => void doLogout()} onOpenCommandPalette={() => setCmdkOpen(true)} onOpenSettings={() => setSettingsOpen(true)} onSetAutoApprove={setAutoApprove} onSetPlanMode={setPlanMode} onTogglePanel={togglePanel} onToggleTheme={toggleTheme} />
        <Timeline editText={editText} editingMsgId={editingMsgId} empty={messages.length === 0} hasNewContent={hasNewContent} isAtBottom={isAtBottom} messages={messages} starters={STARTERS} streamingId={streamingId} timelineRef={timelineRef} trustedRoot={trustedRoot} onBeginEdit={beginEdit} onCopyText={copyText} onHandleApprove={(m) => void handleApprove(m)} onOpenOrPreview={openOrPreview} onPatchAssistant={patchAssistant} onQuickSend={quickSend} onRegenerate={regenerate} onScrollToBottom={scrollToBottom} onSetEditingMsgId={setEditingMsgId} onSetEditText={setEditText} onSubmitEdit={submitEdit} />
        <AppComposerDock commands={commands} defaultBaseUrl={defaultBaseUrl} defaultModel={defaultModel} defaultProvider={defaultProvider} history={history} models={models} recipes={recipes} selectedRecipe={selectedRecipe} streamingId={streamingId} autoClarify={autoClarify} onClearRecipe={() => setSelectedRecipe(null)} onPickTemplate={setSelectedRecipe} onRefinePrompt={handleRefinePrompt} onSearchFiles={searchFiles} onSend={(t, meta) => void handleSend(t, meta)} onStopStreaming={stopStreaming} />
      </div>
      <AppSidePanel panel={panel} trustedRoot={trustedRoot} onClose={() => setPanel('none')} onRunSubagent={(g, s) => void handleRunSubagent(g, s)} />
      <AppOverlays cmdkOpen={cmdkOpen} commands={commands} previewPath={previewPath} onboardingOpen={onboardingOpen} settingsOpen={settingsOpen} theme={theme} trustedRoot={trustedRoot} user={user} autoClarify={autoClarify} onCloseCommandPalette={() => setCmdkOpen(false)} onCompleteOnboarding={completeOnboarding} onClosePreview={() => setPreviewPath(null)} onCloseSettings={() => setSettingsOpen(false)} onOpenSettingsFromOnboarding={openSettingsFromOnboarding} onLogout={() => { setSettingsOpen(false); void doLogout(); }} onSettingsSaved={(info) => { setChatEnabled(Boolean(info.chatEnabled)); setDefaultProvider(info.provider || 'kimi-api'); setDefaultBaseUrl(info.baseUrl || ''); if (info.model) { setDefaultModel(info.model); setModels([info.model]); } }} onSetAutoClarify={setAutoClarify} onSetTheme={setTheme} />
    </div>
  );
}
