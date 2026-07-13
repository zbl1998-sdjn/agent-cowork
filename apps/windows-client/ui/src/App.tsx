// App 根组件(UI · 应用编排层)
// ---------------------------------------------------------------------------
// 职责:顶层布局编排——组合各 hooks(会话/运行时/输入/流)与子组件(侧栏/时间线/输入框/面板),把用户操作接到
//       lib/api。本身只做编排与连线,具体数据逻辑在 hooks、渲染在 components(plan/00 目标:App < 250 行)。
// 依赖:hooks/* + components/* + lib/api + lib/app-logic 纯逻辑。
import { useCallback, useMemo, useRef, useState } from 'react';
import { agentChatStream, cancelRun, fileToUpload, getKimiInfo, importRecipeTemplate, importUploads, newIdempotencyKey, openPath, postJson, refinePrompt, runSubagent, subscribeRunEvents, type SubagentStep } from './lib/api';
import { buildAgentChatStreamOptions, hasSessionModelAccess, reconcileChatEnabled, reduceAssistantRunEvent, resolveUploadedTemplatePaths } from './lib/app-logic';
import { latestWorkbenchGeneration } from './lib/workbench-logic';
import { latestArtifactMessage } from './lib/artifact-canvas';
import { loadConversations, nextMessageId, PREVIEWABLE_RE } from './lib/app-constants';
import type { AssistantMessage, Message, RecipeRunResponse, SidePanel } from './lib/app-types';
import type { AgentMode, RunEvent } from './lib/types';
import { buildChatStreamCallbacks, humanizeChatTurnError } from './lib/chat-stream-callbacks';
import { humanizeError } from './lib/friendly-error';
import { isImagePath } from './lib/conversations';
import { Login } from './components/Login';
import { ConversationRail } from './components/ConversationRail';
import { AppHeader } from './components/AppHeader';
import { SecurityStatusBar } from './components/SecurityStatusBar';
import { Timeline } from './components/chat/Timeline';
import { AppComposerDock } from './components/AppComposerDock';
import { AppSidePanel } from './components/AppSidePanel';
import { AppContextRail } from './components/AppContextRail';
import { ConversationWorkspace } from './components/ConversationWorkspace';
import { AppOverlays } from './components/AppOverlays';
import { Icon } from './components/ui/Icon';
import type { Command } from './components/CommandPalette';
import type { ComposerDraftPreview, ComposerMeta, FileHit, Recipe, WorkbenchPreviewState } from './components/Composer';
import { useStickToBottom } from './hooks/useStickToBottom';
import { useConversations } from './hooks/useConversations';
import { useAppRuntimeState } from './hooks/useAppRuntimeState';
import { useRecipeCapture } from './hooks/useRecipeCapture';
import { useAgentTeamTimeline } from './hooks/useAgentTeamTimeline';
type ImportedRecipeResponse = {
  recipe: {
    id: string;
    name: string;
    description?: string;
    prompt?: string;
  };
};
export function App() {
  const [selectedRecipe, setSelectedRecipe] = useState<Recipe | null>(null);
  const [messages, setMessages] = useState<Message[]>(() => loadConversations()[0]?.messages || []);
  const [panel, setPanel] = useState<SidePanel>('none');
  const [mode, setMode] = useState<AgentMode>('execute');
  const permissionMode = mode === 'plan' ? 'plan' : mode === 'auto' ? 'guarded_auto' : 'manual';
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [contextRailCollapsed, setContextRailCollapsed] = useState(true);
  const {
    applyKimiInfo,
    authReady,
    autoClarify,
    autoContextCompaction,
    chatEnabled,
    closeSettings,
    cmdkOpen,
    completeOnboarding,
    continueAsGuest,
    defaultBaseUrl,
    defaultModel,
    defaultProvider,
    doLogout,
    fontFamily,
    fontScale,
    handleAuthed,
    history,
    models,
    modelProviders,
    onboardingOpen,
    openSettings,
    openSettingsFromOnboarding,
    openSettingsTabFromOnboarding,
    recipes,
    securityStatus,
    setAutoClarify,
    setAutoContextCompaction,
    setChatEnabled,
    setCmdkOpen,
    setFontFamily,
    setFontScale,
    setTheme,
    settingsInitialTab,
    settingsOpen,
    starters,
    theme,
    toggleTheme,
    trustedRoot: hostTrustedRoot,
    upsertRecipe,
    user,
  } = useAppRuntimeState();
  const agentTeamTimeline = useAgentTeamTimeline({ enabled: Boolean(user) });
  const [composerDraft, setComposerDraft] = useState<ComposerDraftPreview>(() => ({
    text: '',
    files: [],
    provider: defaultProvider || 'kimi-api',
    model: defaultModel || '',
    thinking: 'standard',
    updatedAt: new Date().toISOString(),
  }));
  // 工作区切换器:用户手选目录优先于 host 默认目录;每次请求都传 trustedRoot,由 host path-policy 做最终校验。
  const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
  const trustedRoot = workspaceOverride || hostTrustedRoot;
  const workbenchPreview = useMemo<WorkbenchPreviewState>(() => ({
    ...composerDraft,
    provider: composerDraft.provider || defaultProvider || 'kimi-api',
    model: composerDraft.model || defaultModel || '未选择',
    mode,
    workspace: trustedRoot,
    recipe: selectedRecipe,
    streaming: Boolean(streamingId),
    generation: latestWorkbenchGeneration(messages),
  }), [composerDraft, defaultModel, defaultProvider, messages, mode, selectedRecipe, streamingId, trustedRoot]);
  const artifactMessage = useMemo(() => latestArtifactMessage(messages), [messages]);
  const conversations = useConversations({ messages, setMessages, setSelectedRecipe, streamingId, user });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const togglePanel = useCallback((next: SidePanel) => setPanel((current) => (current === next ? 'none' : next)), []);
  // 新建对话时同时关闭当前侧面板,切回对话视图——否则从面板(工具/记忆等)点"新建对话"会
  // 停在面板上、看不到新对话(dogfood 实测的 UX 卡点)。
  const startNewConversation = useCallback(() => { setPanel('none'); conversations.newConversation(); }, [conversations]);
  const patchAssistant = useCallback((id: string, patch: (m: AssistantMessage) => AssistantMessage) => {
    setMessages((list) => list.map((m) => (m.id === id && m.role === 'assistant' ? patch(m) : m)));
  }, []);
  const applyArtifactText = useCallback((text: string) => { if (artifactMessage) patchAssistant(artifactMessage.id, (message) => ({ ...message, text })); }, [artifactMessage, patchAssistant]);
  const captureRecipe = useRecipeCapture({ patchAssistant, onRecipeSaved: upsertRecipe });
  const { containerRef: timelineRef, isAtBottom, hasNewContent, scrollToBottom } = useStickToBottom(messages, conversations.activeConvId);
  const copyText = useCallback((t: string) => {
    try { void navigator.clipboard.writeText(t); } catch { /* 剪贴板在测试/受限 WebView 中可能不可用 */ }
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
  }, { onError: (error) => patchAssistant(assistantId, (m) => m.status === 'done' ? m : ({ ...m, status: 'failed', text: m.text || humanizeError(error, { action: '恢复运行事件' }) })) }), [patchAssistant]);
  const uploadAttachments = useCallback(async (files: File[]): Promise<string[]> => {
    if (!files.length) return [];
    const payload = await Promise.all(files.map((f) => fileToUpload(f)));
    const res = await importUploads(payload, trustedRoot);
    return (res.imported || []).map((it) => it.path || it.relativePath || '').filter(Boolean);
  }, [trustedRoot]);
  const uploadTemplates = useCallback(async (files: File[]): Promise<Recipe[]> => {
    const imported: Recipe[] = [];
    for (const file of files) {
      let template: unknown;
      try {
        template = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name}: 模板必须是 JSON`);
      }
      const saved = await importRecipeTemplate<ImportedRecipeResponse>(template);
      const recipe = {
        id: saved.recipe.id,
        name: saved.recipe.name,
        summary: saved.recipe.description || saved.recipe.prompt,
      };
      upsertRecipe(recipe);
      imported.push(recipe);
    }
    return imported;
  }, [upsertRecipe]);
  const runRecipeTurn = useCallback(async (assistantId: string, recipeId: string, prompt: string, uploaded: string[]) => {
    try {
      const res = await postJson<RecipeRunResponse>(`/api/recipes/${encodeURIComponent(recipeId)}/run`, {
        trustedRoot, prompt, files: uploaded.map((p) => ({ path: p })), idempotencyKey: newIdempotencyKey('recipe'),
      });
      patchAssistant(assistantId, (m) => ({ ...m, runId: res.runId, operations: res.operations || [], aiGenerated: Boolean(res.aiGenerated), fileOperationApprovalId: res.fileOperationApprovalId || null, sources: res.sources || [], status: 'awaiting_approval', approvalState: (res.operations || []).length ? 'awaiting' : 'idle' }));
      wireEvents(assistantId, res.runId);
    } catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: humanizeError(error, { action: '运行技能' }) })); }
  }, [trustedRoot, patchAssistant, wireEvents]);
  const handleSend = useCallback(async (text: string, meta: ComposerMeta & { resumeRunId?: string }) => {
    const resumeRunId = meta.resumeRunId?.trim(); const resumedTemplatePaths = resumeRunId ? (messagesRef.current.find((message) => message.role === 'assistant' && message.runId === resumeRunId) as AssistantMessage | undefined)?.templateFiles || [] : [];
    const userText = text || (meta.files.length ? `（已上传 ${meta.files.length} 个文件）` : '');
    setMessages((list) => [...list, { id: nextMessageId(), role: 'user', text: userText }]);
    const assistantId = nextMessageId();
    setMessages((list) => [...list, { id: assistantId, role: 'assistant', status: 'thinking', progress: [], operations: [], sources: [], approvalState: 'idle' }]);
    let uploaded: string[] = [];
    try {
      uploaded = resumeRunId ? [] : await uploadAttachments(meta.files);
    } catch (error) {
      patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: humanizeError(error, { action: '上传附件' }) }));
      return;
    }
    const templatePaths = resolveUploadedTemplatePaths(meta.files, meta.templateFiles, uploaded, resumedTemplatePaths); if (templatePaths.length) patchAssistant(assistantId, (message) => ({ ...message, templateFiles: templatePaths }));
    if (!resumeRunId && selectedRecipe) {
      // recipe 来源 = 上传的附件 + 经 @ 提及引用的工作区文件(修复:「引用本地文件」选的源
      // 之前没进 recipe files,导致 requiresSources 配方报「引用 0 个」)。
      const recipeFiles = [...uploaded, ...(meta.referencedFiles || [])];
      await runRecipeTurn(assistantId, selectedRecipe.id, text, recipeFiles);
      return;
    }
    const sessionModelAccess = hasSessionModelAccess(meta.modelConfig);
    let enabled = Boolean(resumeRunId) || chatEnabled || sessionModelAccess;
    if (!enabled) {
      try {
        const reconciled = reconcileChatEnabled(chatEnabled, await getKimiInfo());
        enabled = reconciled.enabled;
        if (reconciled.shouldUpdateState) setChatEnabled(true);
      } catch { /* host 不可达时继续走配置兜底 */ }
    }
    if (!enabled) {
      // 未配置对话模型时,不要盲跑第一个技能(此前固定跑 recipes[0]=会议纪要,任何输入都撞
      // "需要来源材料"报错);给出清晰引导——配模型,或点技能卡片显式选一个再发。
      patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: '通用对话需要先配置本机模型：请在设置里选择 Ollama/LM Studio（回环地址），或使用管理员明确放行的客户模型网关。当前 beta 不支持公网云模型直连。想直接跑办公技能，请点上方技能卡片后再发送。' }));
      return;
    }

    // 上传附件 + @ 提及引用的工作区文件都作为「文件」上下文附给 agent,给出真实路径,
    // 避免 agent 拿文本里的 @basename(带 @)去 Read 而 ENOENT(dogfood 实测的多余失败调用)。
    const contextFiles = resumeRunId ? [] : [...uploaded, ...(meta.referencedFiles || [])];
    const prompt = resumeRunId ? '' : contextFiles.length ? `${text}\n\n[已引用/上传的文件]\n${contextFiles.join('\n')}` : text;
    setStreamingId(assistantId);
    try {
      await agentChatStream(prompt, buildAgentChatStreamOptions({
        trustedRoot,
        model: meta.model,
        modelConfig: meta.modelConfig,
        thinking: meta.thinking,
        permissionMode,
        images: contextFiles.filter((p) => isImagePath(p)), templateFiles: templatePaths,
        resumeRunId,
        conversationId: conversations.activeConvId,
        autoContextCompaction,
      }), buildChatStreamCallbacks({ assistantId, patchAssistant, setStreamingId }));
    } catch (error) { setStreamingId(null); patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: humanizeChatTurnError(error) })); }
  }, [autoContextCompaction, chatEnabled, conversations.activeConvId, patchAssistant, permissionMode, runRecipeTurn, selectedRecipe, setChatEnabled, trustedRoot, uploadAttachments]);

  const quickSend = useCallback((text: string) => void handleSend(text, { files: [], model: defaultModel, thinking: 'standard' }), [handleSend, defaultModel]);
  const resumeRun = useCallback((runId: string) => void handleSend('继续', { files: [], model: defaultModel, thinking: 'standard', resumeRunId: runId }), [handleSend, defaultModel]);
  const regenerate = useCallback((assistantId: string) => {
    const currentMessages = messagesRef.current;
    const idx = currentMessages.findIndex((m) => m.id === assistantId);
    for (let i = idx - 1; i >= 0; i -= 1) {
      const candidate = currentMessages[i];
      const text = candidate?.role === 'user' ? candidate.text : '';
      if (text) { quickSend(text); return; }
    }
  }, [quickSend]);
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
    catch (error) { patchAssistant(assistantId, (m) => ({ ...m, status: 'failed', text: humanizeError(error, { action: '子任务' }) })); }
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
    } catch (error) { patchAssistant(message.id, (m) => ({ ...m, text: humanizeError(error, { action: '应用文件变更' }) })); }
  }, [trustedRoot, patchAssistant]);
  const handleApproveMessage = useCallback((message: AssistantMessage) => void handleApprove(message), [handleApprove]);
  const commands = useMemo<Command[]>(() => [
    { id: 'new', label: '新建对话', run: startNewConversation }, { id: 'theme', label: theme === 'dark' ? '切换到浅色' : '切换到深色', run: toggleTheme }, { id: 'mode-plan', label: '模式：计划', run: () => setMode('plan') },
    { id: 'mode-exec', label: '模式：执行', run: () => setMode('execute') }, { id: 'mode-auto', label: '模式：安全自动（高风险仍需批准）', run: () => setMode('auto') }, { id: 'auto-clarify', label: autoClarify ? '关闭发送前澄清' : '开启发送前澄清', run: () => setAutoClarify((v) => !v) }, { id: 'p-tools', label: '面板：工具', run: () => setPanel('tools') }, { id: 'p-viz', label: '面板：可视化编辑', run: () => setPanel('viz') },
    { id: 'p-tasks', label: '面板：任务中心', run: () => setPanel('tasks') }, { id: 'p-conn', label: '面板：连接器', run: () => setPanel('connectors') }, { id: 'p-art', label: '面板：产物', run: () => setPanel('artifacts') }, { id: 'p-sched', label: '面板：定时任务', run: () => setPanel('schedules') },
    { id: 'p-memory', label: '面板：记忆', run: () => setPanel('memory') }, { id: 'p-observe', label: '面板：成本 / 可观测', run: () => setPanel('observability') },
    { id: 'settings', label: '模型设置', run: () => openSettings('model') }, { id: 'logout', label: '退出登录', run: () => void doLogout() },
  ], [autoClarify, startNewConversation, doLogout, openSettings, setAutoClarify, theme, toggleTheme]);

  if (!authReady) return <div className="auth-boot"><span className="brand-dot" aria-hidden="true" /> 正在启动 Agent Cowork…</div>;
  if (!user) return <Login onAuthed={handleAuthed} onGuest={continueAsGuest} />;

  return (
    <div className={`app-shell${panel !== 'none' ? ' has-side-panel' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <ConversationRail activeConvId={conversations.activeConvId} convSearch={conversations.convSearch} conversations={conversations.visibleConversations} renamingId={conversations.renamingId} renameText={conversations.renameText} onCommitRename={conversations.commitRename} onDelete={conversations.deleteConversation} onExport={conversations.exportConversation} onNew={startNewConversation} onRenameText={conversations.setRenameText} onSearch={conversations.setConvSearch} onSetRenamingId={conversations.setRenamingId} onSwitch={conversations.switchConversation} onSwitchBranch={conversations.switchBranch} onTogglePin={conversations.togglePin} panel={panel} onNavigate={togglePanel} />
      <div className="app-content">
        <AppHeader mode={mode} theme={theme} trustedRoot={trustedRoot} user={user} sidebarCollapsed={sidebarCollapsed} onLogout={() => void doLogout()} onOpenCommandPalette={() => setCmdkOpen(true)} onSetMode={setMode} onSwitchWorkspace={setWorkspaceOverride} onToggleTheme={toggleTheme} onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />
        <SecurityStatusBar status={securityStatus} />
        {panel !== 'none' ? (
          <AppSidePanel panel={panel} trustedRoot={trustedRoot} workbenchPreview={workbenchPreview} onClose={() => setPanel('none')} onRunSubagent={(g, s) => void handleRunSubagent(g, s)} />
        ) : (
          <ConversationWorkspace artifactId={artifactMessage?.id || null} artifactText={artifactMessage?.text || ''} streaming={Boolean(streamingId)} onApplyArtifact={applyArtifactText} onRequestRevision={quickSend}>
            <Timeline editText={editText} editingMsgId={editingMsgId} empty={messages.length === 0} hasNewContent={hasNewContent} isAtBottom={isAtBottom} messages={messages} starters={starters} streamingId={streamingId} timelineRef={timelineRef} trustedRoot={trustedRoot} onBeginEdit={beginEdit} onCopyText={copyText} onHandleApprove={handleApproveMessage} onOpenOrPreview={openOrPreview} onPatchAssistant={patchAssistant} onQuickSend={quickSend} onCaptureRecipe={captureRecipe} onRegenerate={regenerate} onResumeRun={resumeRun} onScrollToBottom={scrollToBottom} onSetEditingMsgId={setEditingMsgId} onSetEditText={setEditText} onSubmitEdit={submitEdit} />
            <AppComposerDock commands={commands} defaultBaseUrl={defaultBaseUrl} defaultModel={defaultModel} defaultProvider={defaultProvider} history={history} models={models} modelProviders={modelProviders} recipes={recipes} selectedRecipe={selectedRecipe} streamingId={streamingId} autoClarify={autoClarify} onClearRecipe={() => setSelectedRecipe(null)} onDraftChange={setComposerDraft} onPickTemplate={setSelectedRecipe} onRefinePrompt={handleRefinePrompt} onSearchFiles={searchFiles} onSend={(t, meta) => void handleSend(t, meta)} onStopStreaming={stopStreaming} onUploadTemplates={uploadTemplates} />
          </ConversationWorkspace>
        )}
      </div>
      {contextRailCollapsed ? (
        <button type="button" className="context-expand" onClick={() => setContextRailCollapsed(false)} title="展开上下文栏" aria-label="展开上下文栏">
          <Icon name="sidebar" size={16} />
        </button>
      ) : (
        <AppContextRail trustedRoot={trustedRoot} recipes={recipes} streamingId={streamingId} mode={mode} model={workbenchPreview.model} messageCount={messages.length} agentTeamView={agentTeamTimeline.view} agentTeamLoading={agentTeamTimeline.loading} agentTeamError={agentTeamTimeline.error} onRefreshAgentTeam={agentTeamTimeline.refresh} onOpenRuns={() => setPanel('tasks')} onPickRecipe={setSelectedRecipe} onToggle={() => setContextRailCollapsed(true)} />
      )}
      <AppOverlays cmdkOpen={cmdkOpen} commands={commands} previewPath={previewPath} onboardingOpen={onboardingOpen} settingsOpen={settingsOpen} settingsInitialTab={settingsInitialTab} theme={theme} fontScale={fontScale} fontFamily={fontFamily} trustedRoot={trustedRoot} user={user} autoClarify={autoClarify} autoContextCompaction={autoContextCompaction} onCloseCommandPalette={() => setCmdkOpen(false)} onCompleteOnboarding={completeOnboarding} onClosePreview={() => setPreviewPath(null)} onCloseSettings={closeSettings} onOpenSettingsFromOnboarding={openSettingsFromOnboarding} onOpenSettingsTabFromOnboarding={openSettingsTabFromOnboarding} onLogout={() => { closeSettings(); void doLogout(); }} onSettingsSaved={applyKimiInfo} onSetAutoClarify={setAutoClarify} onSetAutoContextCompaction={setAutoContextCompaction} onSetTheme={setTheme} onSetFontScale={setFontScale} onSetFontFamily={setFontFamily} />
    </div>
  );
}
