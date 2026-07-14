// classic-script 对话运行器:负责普通聊天流程;app.js 只判断 prompt 走聊天还是协作规划。
(function () {
  function createChatRunner({
    state,
    textCandidate,
    activeFiles,
    readCandidateSummary,
    tryAgentEngineChat,
    refreshRunCards,
    showChatResponse,
    appendUserMessage,
    appendAssistantMessage,
    appendMessageText,
    addProgressLines,
    setMessageStatus,
    setRunChip,
    setStatus,
    shortRunId,
  }: any) {
    async function sendChatMessage(prompt: any) {
      appendUserMessage(prompt);
      const message = appendAssistantMessage("我先读取当前可用上下文，然后直接回复。", { status: "对话 · 处理中" });
      if (!state.hostApi) {
        const fallback = `已收到：“${prompt.slice(0, 120)}”。通过 localhost 启动后可调用 Agent。`;
        showChatResponse(fallback);
        appendMessageText(message, fallback);
        setMessageStatus(message, "对话 · 本地预览");
        return;
      }
      setStatus("正在发送给 Agent");
      const candidate = textCandidate(activeFiles());
      const summary = await readCandidateSummary(candidate);
      addProgressLines(message, [
        {
          state: "done",
          title: candidate ? `已读取上下文：${candidate.path}` : "当前没有额外本地文件上下文",
        },
        {
          state: "running",
          title: state.modelApiEnabled ? "正在调用模型 API 对话" : "模型 API 未配置，使用本地安全回复",
        },
      ]);
      const reply = await tryAgentEngineChat(prompt, summary);
      state.lastRun = reply.runId
        ? {
            id: reply.runId,
            path: reply.runPath,
            durationMs: reply.durationMs,
            failed: reply.failed === true,
          }
        : null;
      showChatResponse(reply.text);
      appendMessageText(message, reply.text);
      if (reply.used) {
        setRunChip(`Agent Chat · ${shortRunId(reply.runId)} · ${reply.durationMs}ms`, "ready");
        setStatus("Agent 已回复");
        setMessageStatus(message, "对话 · 已回复");
      } else if (reply.failed) {
        setRunChip(`Agent Chat 失败 · ${shortRunId(reply.runId)}`, "muted");
        setStatus("Agent 已降级");
        setMessageStatus(message, "对话 · 已降级");
      } else {
        setStatus("本地回复");
        setMessageStatus(message, "对话 · 本地回复");
      }
      await refreshRunCards(reply.runId);
    }

    return { sendChatMessage };
  }

  window.AgentCoworkChatRunner = {
    createChatRunner,
  };
})();
