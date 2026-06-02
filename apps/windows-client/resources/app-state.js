// Classic-script state defaults live here so app.js stays a thin composition root.
(function () {
    const placeholders = {
        chat: "今天想让 Kimi 做什么？",
        cowork: "选择本地文件夹，描述要让 Agent Cowork 在本机完成的操作",
        code: "描述要让 Kimi 在本地检查的代码任务",
        projects: "搜索或打开一个项目",
        artifacts: "查找产物或审计日志",
        customize: "告诉 Kimi 这个工作区应该如何运行",
    };
    function createInitialState() {
        return {
            view: "chat",
            workspace: "C:\\Users\\Administrator\\Desktop\\agent cowork",
            files: [],
            operations: [],
            approved: false,
            hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
            kimiApiEnabled: false,
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
