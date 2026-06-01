// Classic-script Kimi runner. It owns API calls and degradation messages while
// app.js keeps the surrounding conversation/workbench orchestration.
(function () {
  function createKimiRunner({ state, postJson, setRunChip, setStatus, shortRunId }) {
    async function tryKimiApiPlan(prompt, summary) {
      if (!state.kimiApiEnabled) {
        setRunChip("Kimi API 未配置", "muted");
        return {
          used: false,
          text: "Kimi API 未配置；当前使用本地只读摘要生成审批草稿。",
        };
      }

      try {
        setStatus("正在调用 Kimi API");
        const result = await postJson("/api/kimi/plan", {
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
      } catch (error) {
        const runId = error.payload?.runId;
        setRunChip(runId ? `Kimi API 失败 · ${shortRunId(runId)}` : "Kimi API 已降级", "muted");
        return {
          used: false,
          text: `Kimi API 暂不可用，已降级到本地计划：${error.message}`,
          runId,
          runPath: error.payload?.runPath,
          failed: Boolean(runId),
        };
      }
    }

    async function tryKimiChat(prompt, summary) {
      if (!state.kimiApiEnabled) {
        setRunChip("Kimi API 未配置", "muted");
        return {
          used: false,
          text: `Kimi API 未配置；已收到消息：“${prompt.slice(0, 80)}”。需要真实对话时请设置 KIMI_API_KEY 或 MOONSHOT_API_KEY 后启动。`,
        };
      }

      try {
        setRunChip("Kimi API 对话中", "ready");
        const result = await postJson("/api/kimi/chat", {
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
      } catch (error) {
        const runId = error.payload?.runId;
        setRunChip(runId ? `Kimi API 失败 · ${shortRunId(runId)}` : "Kimi API 已降级", "muted");
        return {
          used: false,
          text: `Kimi API 暂不可用：${error.message}`,
          runId,
          runPath: error.payload?.runPath,
          failed: Boolean(runId),
        };
      }
    }

    return {
      tryKimiApiPlan,
      tryKimiChat,
    };
  }

  window.AgentCoworkKimiRunner = {
    createKimiRunner,
  };
})();
