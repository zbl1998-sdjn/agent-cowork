// 浏览器资源层的控制器装配根(resources · UI 运行时组装)
// ---------------------------------------------------------------------------
// 职责:把拆分后的历史记录、工作区、审批、澄清、上传、配方、聊天、输入框弹层、
//   计划执行与事件绑定控制器集中连线。这里只做依赖注入和启动顺序编排,不承载
//   业务逻辑,从而让每个控制器继续保持单一职责。
(function () {
  function startApp({ state, elements: dom, services: svc, utils: u, api, runEvents }: any) {
    // planRunner 与 clarificationController 彼此需要回调,先放占位对象打断
    // 装配期循环依赖;真正方法会在对应控制器创建后覆盖。
    let planRunner: AgentCoworkJson = {};
    let clarificationController: AgentCoworkJson = {};
    const generatePlan = (options?: AgentCoworkJson) => planRunner.generatePlan(options);
    const hideClarification = () => clarificationController.hideClarification();

    // 历史运行记录是多数工作流的刷新来源,先创建以便后续控制器复用 refresh/select。
    const history = window.AgentCoworkRunHistory.createRunHistoryController({
      state,
      composer: dom.composer,
      runList: dom.runList,
      runSummary: dom.runSummary,
      getJson: api.getJson,
      compactText: u.compactText,
      formatDuration: u.formatDuration,
      formatRunTime: u.formatRunTime,
      renderRunEventPayload: runEvents.renderRunEventPayload,
      renderInteraction: svc.renderInteraction,
      renderRecipes: svc.renderRecipes,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      setRunChip: svc.setRunChip,
      appendAssistantMessage: svc.appendAssistantMessage,
      scrollConversationToEnd: svc.scrollConversationToEnd,
      runStatusText: u.runStatusText,
      runTypeText: u.runTypeText,
      shortRunId: u.shortRunId,
    });

    // 工作区加载器持有文件树、配方列表与 artifact 目录刷新能力,属于 UI 到 host 的读写边界。
    const workspace = window.AgentCoworkWorkspaceLoader.createWorkspaceLoader({
      state,
      getJson: api.getJson,
      postJson: api.postJson,
      renderRecipes: svc.renderRecipes,
      summarizeFiles: svc.summarizeFiles,
      renderFiles: svc.renderFiles,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      setRunChip: svc.setRunChip,
      workspacePath: dom.workspacePath,
      refreshRunCards: history.refreshRunCards,
      loadArtifactCatalog: svc.loadArtifactCatalog,
    });

    // 审批控制器只接收已注入的计划生成与 UI 渲染函数,避免直接耦合计划执行器内部实现。
    const { approvePlan } = window.AgentCoworkApprovalRunner.createApprovalRunner({
      state,
      approveButton: dom.approveButton,
      artifactPath: dom.artifactPath,
      postJson: api.postJson,
      idempotencyKey: u.idempotencyKey,
      setView: svc.setView,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      renderInteraction: svc.renderInteraction,
      generatePlan,
      markApprovalDone: svc.markApprovalDone,
      addProgressLines: svc.addProgressLines,
      setMessageStatus: svc.setMessageStatus,
      addArtifactCard: svc.addArtifactCard,
      loadArtifactCatalog: svc.loadArtifactCatalog,
    });

    // 消息动作是时间线卡片上的轻量命令层,负责把用户选择转回澄清/计划/审批工作流。
    const actions = window.AgentCoworkMessageActions.createMessageActions({
      state,
      composer: dom.composer,
      renderRecipes: svc.renderRecipes,
      hideClarification,
      generatePlan,
      approvePlan,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      setView: svc.setView,
      setMessageStatus: svc.setMessageStatus,
      appendUserMessage: svc.appendUserMessage,
      scrollConversationToEnd: svc.scrollConversationToEnd,
    });

    // 澄清控制器在创建后回填到占位对象,这样计划执行器可安全调用 show/hide。
    clarificationController = window.AgentCoworkClarification.createClarificationController({
      state,
      composer: dom.composer,
      clarifyPanel: dom.clarifyPanel,
      clarifyOptions: dom.clarifyOptions,
      renderRecipes: svc.renderRecipes,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      renderInteraction: svc.renderInteraction,
      appendUserMessage: svc.appendUserMessage,
      appendAssistantMessage: svc.appendAssistantMessage,
      addClarificationCard: actions.addClarificationCard,
      generatePlan,
    });

    // 上传控制器只通过 host API 写入工作区,完成后刷新工作区树与 artifact 目录。
    const upload = window.AgentCoworkFileUpload.createFileUploadController({
      state,
      composer: dom.composer,
      postJson: api.postJson,
      arrayBufferToBase64: u.arrayBufferToBase64,
      setView: svc.setView,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      refreshWorkspaceTree: workspace.refreshWorkspaceTree,
      appendAssistantMessage: svc.appendAssistantMessage,
      addArtifactCard: svc.addArtifactCard,
      renderInteraction: svc.renderInteraction,
    });

    // 配方运行器复用审批动作和 SSE 事件订阅,保证配方计划与普通计划走同一进度表达。
    const { runRecipePlan } = window.AgentCoworkRecipeRunner.createRecipeRunner({
      state,
      approveButton: dom.approveButton,
      postJson: api.postJson,
      idempotencyKey: u.idempotencyKey,
      recipeFiles: svc.recipeFiles,
      basename: u.basename,
      compactText: u.compactText,
      subscribeRunEvents: runEvents.subscribeRunEvents,
      scrollConversationToEnd: svc.scrollConversationToEnd,
      appendAssistantMessage: svc.appendAssistantMessage,
      addProgressLines: svc.addProgressLines,
      addPreviewCard: svc.addPreviewCard,
      addSourcesFooter: svc.addSourcesFooter,
      addApprovalActions: actions.addApprovalActions,
      setMessageStatus: svc.setMessageStatus,
      renderInteraction: svc.renderInteraction,
      renderOperations: svc.renderOperations,
      setArtifact: svc.setArtifact,
      setRunChip: svc.setRunChip,
      refreshRunCards: history.refreshRunCards,
      setStatus: svc.setStatus,
      shortRunId: u.shortRunId,
    });

    // 聊天运行器是非计划型对话路径,仍复用 run cards 与消息渲染,保证历史记录一致。
    const { sendChatMessage } = window.AgentCoworkChatRunner.createChatRunner({
      state,
      textCandidate: svc.textCandidate,
      activeFiles: svc.activeFiles,
      readCandidateSummary: svc.readCandidateSummary,
      tryAgentEngineChat: svc.tryAgentEngineChat,
      refreshRunCards: history.refreshRunCards,
      showChatResponse: svc.showChatResponse,
      appendUserMessage: svc.appendUserMessage,
      appendAssistantMessage: svc.appendAssistantMessage,
      appendMessageText: svc.appendMessageText,
      addProgressLines: svc.addProgressLines,
      setMessageStatus: svc.setMessageStatus,
      setRunChip: svc.setRunChip,
      setStatus: svc.setStatus,
      shortRunId: u.shortRunId,
    });

    // 输入框弹层需要跨工作区文件、配方和历史运行记录做候选提示,因此放在共享装配层连线。
    const popover = window.AgentCoworkComposerPopover.createComposerPopover({
      state,
      composer: dom.composer,
      composerPopover: dom.composerPopover,
      searchLocalFiles: workspace.searchLocalFiles,
      renderRecipes: svc.renderRecipes,
      selectHistoryRun: history.selectHistoryRun,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      getJson: api.getJson,
      basename: u.basename,
      compactText: u.compactText,
      runStatusText: u.runStatusText,
      runTypeText: u.runTypeText,
      shortRunId: u.shortRunId,
    });

    // 计划执行器是核心编排器:它只消费上方注入的能力,不直接创建其他控制器。
    planRunner = window.AgentCoworkPlanRunner.createPlanRunner({
      state,
      composer: dom.composer,
      approveButton: dom.approveButton,
      chatOutput: dom.chatOutput,
      postJson: api.postJson,
      idempotencyKey: u.idempotencyKey,
      uniqueStamp: u.uniqueStamp,
      joinWin: u.joinWin,
      compactText: u.compactText,
      shortRunId: u.shortRunId,
      setView: svc.setView,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      setRunChip: svc.setRunChip,
      renderInteraction: svc.renderInteraction,
      renderOperations: svc.renderOperations,
      shouldClarify: svc.shouldClarify,
      showClarification: clarificationController.showClarification,
      hideClarification: clarificationController.hideClarification,
      shouldUseCowork: svc.shouldUseCowork,
      maybeSelectRecipe: svc.maybeSelectRecipe,
      activeFiles: svc.activeFiles,
      textCandidate: svc.textCandidate,
      readCandidateSummary: svc.readCandidateSummary,
      tryAgentEnginePlan: svc.tryAgentEnginePlan,
      runRecipePlan,
      sendChatMessage,
      refreshRunCards: history.refreshRunCards,
      appendUserMessage: svc.appendUserMessage,
      appendAssistantMessage: svc.appendAssistantMessage,
      addProgressLines: svc.addProgressLines,
      addPreviewCard: svc.addPreviewCard,
      addSourcesFooter: svc.addSourcesFooter,
      addApprovalActions: actions.addApprovalActions,
      setMessageStatus: svc.setMessageStatus,
    });

    // 事件绑定必须在所有控制器完成装配后执行,否则按钮回调会引用尚未初始化的能力。
    window.AgentCoworkAppEvents.bindAppEvents({
      state,
      composer: dom.composer,
      uploadInput: dom.uploadInput,
      folderInput: dom.folderInput,
      approveButton: dom.approveButton,
      sendButton: dom.sendButton,
      runRefreshButton: dom.runRefreshButton,
      artifactRefreshButton: dom.artifactRefreshButton,
      chatOutput: dom.chatOutput,
      setView: svc.setView,
      setStatus: svc.setStatus,
      setArtifact: svc.setArtifact,
      showChatResponse: svc.showChatResponse,
      appendAssistantMessage: svc.appendAssistantMessage,
      resetInteraction: svc.resetInteraction,
      uploadSelectedFiles: upload.uploadSelectedFiles,
      handleComposerSend: planRunner.handleComposerSend,
      approvePlan,
      refreshRunCards: history.refreshRunCards,
      loadArtifactCatalog: svc.loadArtifactCatalog,
      composerPopoverHandleKey: popover.handleKey,
    });

    // 最后启动首屏加载:初始化视图、读取工作区、渲染历史卡片。
    window.AgentCoworkAppEvents.bootstrapApp({
      setView: svc.setView,
      resetInteraction: svc.resetInteraction,
      renderRunCards: history.renderRunCards,
      loadHostWorkspace: workspace.loadHostWorkspace,
    });
  }

  window.AgentCoworkControllerAssembly = {
    startApp,
  };
})();
