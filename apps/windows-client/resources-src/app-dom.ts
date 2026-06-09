// DOM 查询集中入口(resources · UI 边界)
// ---------------------------------------------------------------------------
// 职责:把静态 HTML 中的关键选择器一次性收集成强类型元素表。选择器漂移应在
//   启动阶段立即失败,不要等到某个按钮点击后才出现难定位的空引用错误。
(function () {
  // 所有必需元素都走这个断言函数,缺失时带选择器抛错,便于定位 HTML/CSS 漂移。
  function requiredElement<T extends Element>(selector: string): T {
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Missing required UI element: ${selector}`);
    }
    return element as T;
  }

  // 这里按页面区域排列:输入区、artifact/状态区、运行记录、工作区、对话时间线、
  // 工作台、配方和澄清面板。保持顺序稳定可降低资源脚本与静态 HTML 对齐成本。
  function collectAppDom() {
    return {
      // 输入与主动作区
      composer: requiredElement<HTMLTextAreaElement>(".composer textarea"),
      composerPopover: requiredElement<HTMLElement>(".composer-popover"),
      uploadInput: requiredElement<HTMLInputElement>(".upload-input"),
      folderInput: requiredElement<HTMLInputElement>(".folder-input"),
      approveButton: requiredElement<HTMLButtonElement>(".approve-button"),
      sendButton: requiredElement<HTMLButtonElement>(".send-button"),
      // artifact 预览与全局状态
      artifactText: requiredElement<HTMLElement>(".artifact-preview p"),
      artifactPath: requiredElement<HTMLElement>(".artifact-preview code"),
      statusText: requiredElement<HTMLElement>(".status-text"),
      runChip: requiredElement<HTMLElement>(".run-chip"),
      // 运行历史与 artifact 目录刷新入口
      runSummary: requiredElement<HTMLElement>(".run-summary"),
      runList: requiredElement<HTMLElement>(".run-list"),
      runRefreshButton: requiredElement<HTMLButtonElement>('[data-action="refresh-runs"]'),
      artifactList: requiredElement<HTMLElement>("[data-artifact-list]"),
      artifactRefreshButton: requiredElement<HTMLButtonElement>('[data-action="refresh-artifacts"]'),
      // 工作区文件树与操作列表
      workspacePath: requiredElement<HTMLElement>(".workspace-card > strong"),
      workspaceMeta: requiredElement<HTMLElement>(".workspace-card > p"),
      fileList: requiredElement<HTMLElement>(".file-list"),
      operationList: requiredElement<HTMLElement>(".operation-list"),
      // 对话输出与空态
      chatOutput: requiredElement<HTMLElement>(".chat-output"),
      chatOutputText: requiredElement<HTMLElement>(".chat-output p"),
      conversationTimeline: requiredElement<HTMLElement>(".conversation-timeline"),
      conversationEmpty: requiredElement<HTMLElement>(".conversation-empty"),
      // 工作台标题、摘要与交互卡片
      workbenchTitle: requiredElement<HTMLElement>(".workbench-title"),
      workbenchCopy: requiredElement<HTMLElement>(".workbench-copy"),
      interactionSubtitle: requiredElement<HTMLElement>(".interaction-subtitle"),
      interactionItems: requiredElement<HTMLElement>(".interaction-items"),
      // 配方选择与澄清问题区域
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
