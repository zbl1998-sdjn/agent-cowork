// DOM 查询集中入口(resources · UI 边界)
// ---------------------------------------------------------------------------
// 职责:把静态 HTML 中的关键选择器一次性收集成强类型元素表。选择器漂移应在
//   启动阶段立即失败,不要等到某个按钮点击后才出现难定位的空引用错误。
(function () {
    // 所有必需元素都走这个断言函数,缺失时带选择器抛错,便于定位 HTML/CSS 漂移。
    function requiredElement(selector) {
        const element = document.querySelector(selector);
        if (!element) {
            throw new Error(`Missing required UI element: ${selector}`);
        }
        return element;
    }
    // 这里按页面区域排列:输入区、artifact/状态区、运行记录、工作区、对话时间线、
    // 工作台、配方和澄清面板。保持顺序稳定可降低资源脚本与静态 HTML 对齐成本。
    function collectAppDom() {
        return {
            // 输入与主动作区
            composer: requiredElement(".composer textarea"),
            composerPopover: requiredElement(".composer-popover"),
            uploadInput: requiredElement(".upload-input"),
            folderInput: requiredElement(".folder-input"),
            approveButton: requiredElement(".approve-button"),
            sendButton: requiredElement(".send-button"),
            // artifact 预览与全局状态
            artifactText: requiredElement(".artifact-preview p"),
            artifactPath: requiredElement(".artifact-preview code"),
            statusText: requiredElement(".status-text"),
            runChip: requiredElement(".run-chip"),
            // 运行历史与 artifact 目录刷新入口
            runSummary: requiredElement(".run-summary"),
            runList: requiredElement(".run-list"),
            runRefreshButton: requiredElement('[data-action="refresh-runs"]'),
            artifactList: requiredElement("[data-artifact-list]"),
            artifactRefreshButton: requiredElement('[data-action="refresh-artifacts"]'),
            // 工作区文件树与操作列表
            workspacePath: requiredElement(".workspace-card > strong"),
            workspaceMeta: requiredElement(".workspace-card > p"),
            fileList: requiredElement(".file-list"),
            operationList: requiredElement(".operation-list"),
            // 对话输出与空态
            chatOutput: requiredElement(".chat-output"),
            chatOutputText: requiredElement(".chat-output p"),
            conversationTimeline: requiredElement(".conversation-timeline"),
            conversationEmpty: requiredElement(".conversation-empty"),
            // 工作台标题、摘要与交互卡片
            workbenchTitle: requiredElement(".workbench-title"),
            workbenchCopy: requiredElement(".workbench-copy"),
            interactionSubtitle: requiredElement(".interaction-subtitle"),
            interactionItems: requiredElement(".interaction-items"),
            // 配方选择与澄清问题区域
            recipeSummary: requiredElement(".recipe-summary"),
            recipeList: requiredElement(".recipe-list"),
            recipeClearButton: requiredElement('[data-action="clear-recipe"]'),
            clarifyPanel: requiredElement(".clarify-panel"),
            clarifyOptions: requiredElement(".clarify-options"),
        };
    }
    window.AgentCoworkAppDom = {
        collectAppDom,
    };
})();
