// Classic-script chat runner. It owns the plain conversation flow; app.js only
// decides whether a prompt should go to chat or cowork planning.
(function () {
  function createChatRunner({
    state,
    textCandidate,
    activeFiles,
    readCandidateSummary,
    tryKimiChat,
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
  }) {
    async function sendChatMessage(prompt) {
      appendUserMessage(prompt);
      const message = appendAssistantMessage("我先读取当前可用上下文，然后直接回复。", { status: "对话 · 处理中" });
      if (!state.hostApi) {
        const fallback = `已收到：“${prompt.slice(0, 120)}”。通过 localhost 启动后可调用 Kimi。`;
        showChatResponse(fallback);
        appendMessageText(message, fallback);
        setMessageStatus(message, "对话 · 本地预览");
        return;
      }
      setStatus("正在发送给 Kimi");
      const candidate = textCandidate(activeFiles());
      const summary = await readCandidateSummary(candidate);
      addProgressLines(message, [
        {
          state: "done",
          title: candidate ? `已读取上下文：${candidate.path}` : "当前没有额外本地文件上下文",
        },
        {
          state: "running",
          title: state.kimiApiEnabled ? "正在调用 Kimi API 对话" : "Kimi API 未配置，使用本地安全回复",
        },
      ]);
      const reply = await tryKimiChat(prompt, summary);
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
        setRunChip(`Kimi Chat · ${shortRunId(reply.runId)} · ${reply.durationMs}ms`, "ready");
        setStatus("Kimi 已回复");
        setMessageStatus(message, "对话 · 已回复");
      } else if (reply.failed) {
        setRunChip(`Kimi Chat 失败 · ${shortRunId(reply.runId)}`, "muted");
        setStatus("Kimi 已降级");
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
