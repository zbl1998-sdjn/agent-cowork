// classic-script Agent Engine 运行器:负责 API 调用与降级文案;app.js 负责外围对话/工作台编排。
(function () {
    function createAgentEngineRunner({ state, postJson, setRunChip, setStatus, shortRunId }) {
        async function tryAgentEnginePlan(prompt, summary) {
            if (!state.modelApiEnabled) {
                setRunChip("模型 API 未配置", "muted");
                return {
                    used: false,
                    text: "模型 API 未配置；当前使用本地只读摘要生成审批草稿。",
                };
            }
            try {
                setStatus("正在调用模型 API");
                const result = await postJson("/api/agent-engine/plan", {
                    trustedRoot: state.workspace,
                    prompt,
                    summary,
                    mode: state.view,
                });
                return {
                    used: true,
                    text: result.text,
                    durationMs: result.durationMs,
                    runId: result.runId,
                    runPath: result.runPath,
                };
            }
            catch (error) {
                const runId = error.payload?.runId;
                setRunChip(runId ? `模型 API 失败 · ${shortRunId(runId)}` : "模型 API 已降级", "muted");
                return {
                    used: false,
                    text: `模型 API 暂不可用，已降级到本地计划：${error.message}`,
                    runId,
                    runPath: error.payload?.runPath,
                    failed: Boolean(runId),
                };
            }
        }
        async function tryAgentEngineChat(prompt, summary) {
            if (!state.modelApiEnabled) {
                setRunChip("模型 API 未配置", "muted");
                return {
                    used: false,
                    text: `模型 API 未配置；已收到消息：“${prompt.slice(0, 80)}”。需要真实对话时请设置 KIMI_API_KEY 或 MOONSHOT_API_KEY 后启动。`,
                };
            }
            try {
                setRunChip("模型 API 对话中", "ready");
                const result = await postJson("/api/agent-engine/chat", {
                    trustedRoot: state.workspace,
                    prompt,
                    summary,
                });
                return {
                    used: true,
                    text: result.text,
                    durationMs: result.durationMs,
                    runId: result.runId,
                    runPath: result.runPath,
                };
            }
            catch (error) {
                const runId = error.payload?.runId;
                setRunChip(runId ? `模型 API 失败 · ${shortRunId(runId)}` : "模型 API 已降级", "muted");
                return {
                    used: false,
                    text: `模型 API 暂不可用：${error.message}`,
                    runId,
                    runPath: error.payload?.runPath,
                    failed: Boolean(runId),
                };
            }
        }
        return {
            tryAgentEnginePlan,
            tryAgentEngineChat,
        };
    }
    window.AgentCoworkAgentEngineRunner = {
        createAgentEngineRunner,
    };
})();
