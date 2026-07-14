// 传统 script 的默认状态集中在这里,让 app.js 保持薄编排根。
(function () {
    const placeholders = {
        chat: "今天想让 Agent 做什么？",
        cowork: "选择本地文件夹，描述要让 Agent Cowork 在本机完成的操作",
        code: "描述要让 Agent 在本地检查的代码任务",
        projects: "搜索或打开一个项目",
        artifacts: "查找产物或审计日志",
        customize: "告诉 Agent 这个工作区应该如何运行",
    };
    function createInitialState() {
        return {
            view: "chat",
            workspace: "C:\\Users\\Administrator\\Desktop\\agent cowork",
            files: [],
            operations: [],
            approved: false,
            hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
            modelApiEnabled: false,
            lastRun: null,
            runs: [],
            uploadedFiles: [],
            interactionItems: [],
            recipes: [],
            selectedRecipeId: "",
            selectedRecipeSource: "",
            lastSources: [],
            applyIdempotencyKey: "",
            applyApprovalId: "",
            rollbackApprovalId: "",
            activeTaskMessage: null,
            mentionedFiles: [],
            activeEventSource: null,
        };
    }
    window.AgentCoworkAppState = {
        createInitialState,
        placeholders,
    };
})();
