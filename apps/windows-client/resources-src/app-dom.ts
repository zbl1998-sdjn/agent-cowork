// DOM lookup is intentionally centralized: selector drift should fail at boot.
(function () {
  function requiredElement<T extends Element>(selector: string): T {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Missing required UI element: ${selector}`);
    }
    return element as T;
  }

  function collectAppDom() {
    return {
      composer: requiredElement<HTMLTextAreaElement>(".composer textarea"),
      composerPopover: requiredElement<HTMLElement>(".composer-popover"),
      uploadInput: requiredElement<HTMLInputElement>(".upload-input"),
      folderInput: requiredElement<HTMLInputElement>(".folder-input"),
      approveButton: requiredElement<HTMLButtonElement>(".approve-button"),
      sendButton: requiredElement<HTMLButtonElement>(".send-button"),
      artifactText: requiredElement<HTMLElement>(".artifact-preview p"),
      artifactPath: requiredElement<HTMLElement>(".artifact-preview code"),
      statusText: requiredElement<HTMLElement>(".status-text"),
      runChip: requiredElement<HTMLElement>(".run-chip"),
      runSummary: requiredElement<HTMLElement>(".run-summary"),
      runList: requiredElement<HTMLElement>(".run-list"),
      runRefreshButton: requiredElement<HTMLButtonElement>('[data-action="refresh-runs"]'),
      artifactList: requiredElement<HTMLElement>("[data-artifact-list]"),
      artifactRefreshButton: requiredElement<HTMLButtonElement>('[data-action="refresh-artifacts"]'),
      workspacePath: requiredElement<HTMLElement>(".workspace-card > strong"),
      workspaceMeta: requiredElement<HTMLElement>(".workspace-card > p"),
      fileList: requiredElement<HTMLElement>(".file-list"),
      operationList: requiredElement<HTMLElement>(".operation-list"),
      chatOutput: requiredElement<HTMLElement>(".chat-output"),
      chatOutputText: requiredElement<HTMLElement>(".chat-output p"),
      conversationTimeline: requiredElement<HTMLElement>(".conversation-timeline"),
      conversationEmpty: requiredElement<HTMLElement>(".conversation-empty"),
      workbenchTitle: requiredElement<HTMLElement>(".workbench-title"),
      workbenchCopy: requiredElement<HTMLElement>(".workbench-copy"),
      interactionSubtitle: requiredElement<HTMLElement>(".interaction-subtitle"),
      interactionItems: requiredElement<HTMLElement>(".interaction-items"),
      recipeSummary: requiredElement<HTMLElement>(".recipe-summary"),
      recipeList: requiredElement<HTMLElement>(".recipe-list"),
      recipeClearButton: requiredElement<HTMLButtonElement>('[data-action="clear-recipe"]'),
      clarifyPanel: requiredElement<HTMLElement>(".clarify-panel"),
      clarifyOptions: requiredElement<HTMLElement>(".clarify-options"),
    };
  }

  window.AgentCoworkAppDom = {
    collectAppDom,
  };
})();
