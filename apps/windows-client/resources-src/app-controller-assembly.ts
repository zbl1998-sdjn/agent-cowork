// Controller assembly documents the browser resource dependency graph in one place.
(function () {
  function startApp({ state, elements: dom, services: svc, utils: u, api, runEvents }: any) {
    let planRunner: AgentCoworkJson = {};
    let clarificationController: AgentCoworkJson = {};
    const generatePlan = (options?: AgentCoworkJson) => planRunner.generatePlan(options);
    const hideClarification = () => clarificationController.hideClarification();

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

    const { sendChatMessage } = window.AgentCoworkChatRunner.createChatRunner({
      state,
      textCandidate: svc.textCandidate,
      activeFiles: svc.activeFiles,
      readCandidateSummary: svc.readCandidateSummary,
      tryKimiChat: svc.tryKimiChat,
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
      tryKimiApiPlan: svc.tryKimiApiPlan,
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
