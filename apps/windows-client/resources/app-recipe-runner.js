// Classic-script recipe runner. It owns template execution and preview setup;
// app.js only decides when a prompt should enter this path.
(function () {
  function createRecipeRunner({
    state,
    approveButton,
    postJson,
    idempotencyKey,
    recipeFiles,
    basename,
    compactText,
    subscribeRunEvents,
    scrollConversationToEnd,
    appendAssistantMessage,
    addProgressLines,
    addPreviewCard,
    addSourcesFooter,
    addApprovalActions,
    setMessageStatus,
    renderInteraction,
    renderOperations,
    setArtifact,
    setRunChip,
    refreshRunCards,
    setStatus,
    shortRunId,
  }) {
    async function runRecipePlan(prompt, recipe) {
      const files = recipeFiles();
      const message = state.activeTaskMessage || appendAssistantMessage(`我会按“${recipe.name}”处理本地材料。`, { status: "协作 · 模板处理中" });
      state.activeTaskMessage = message;
      setMessageStatus(message, "协作 · 模板处理中");
      addProgressLines(message, [
        {
          state: "running",
          title: files.length > 0 ? `正在抽取 ${files.length} 个本地文件` : "当前没有可抽取文件，将生成空来源草稿",
        },
      ]);
      renderInteraction(
        [
          {
            state: "done",
            title: "用户指令",
            detail: prompt,
          },
          {
            state: "active",
            title: `运行模板：${recipe.name}`,
            detail: files.length > 0 ? `正在抽取 ${files.length} 个本地文件，生成可审批产物。` : "当前没有可抽取文件，将生成空来源草稿。",
          },
        ],
        "模板正在处理",
      );
      const result = await postJson(`/api/recipes/${encodeURIComponent(recipe.id)}/run`, {
        trustedRoot: state.workspace,
        prompt,
        files: files.map((file) => file.fullPath),
        maxSize: 2 * 1024 * 1024,
        idempotencyKey: idempotencyKey("recipe"),
      });
      state.lastSources = result.sources || [];
      state.lastRun = result.runId
        ? {
            id: result.runId,
            path: result.runPath,
            durationMs: 0,
            failed: false,
          }
        : null;
      state.operations = result.operations || [];
      state.applyIdempotencyKey = idempotencyKey("apply");
      const preview = await postJson("/api/file-ops/preview", {
        trustedRoot: state.workspace,
        operations: state.operations,
      });
      state.applyApprovalId = preview.fileOperationApprovalId || "";
      state.approved = false;
      approveButton.textContent = "审批执行";
      approveButton.classList.remove("is-done");
      renderOperations(preview.operations);
      const sourceCopy = state.lastSources.length > 0
        ? state.lastSources.map((source) => source.relativePath || basename(source.path)).join("、")
        : "无来源文件";
      const sourceExcerpt = compactText(state.lastSources.find((source) => source.excerpt)?.excerpt || "", 150);
      const firstOutput = preview.operations[0]?.path?.replace(state.workspace, ".") || ".AgentCowork/artifacts";
      setArtifact(`${recipe.name} 已生成 ${preview.operations.length} 个操作；来源：${sourceCopy}${sourceExcerpt ? `；摘要：${sourceExcerpt}` : ""}`, firstOutput);
      setRunChip(`模板任务 · ${shortRunId(result.runId)}`, "ready");
      // Prefer the authoritative SSE timeline; fall back to a synchronous summary
      // when EventSource is unavailable (older webview).
      const streamed = subscribeRunEvents(message, result.runId, { state, scrollConversationToEnd });
      if (!streamed) {
        addProgressLines(message, [
          {
            state: "done",
            title: `已生成模板产物预览：${recipe.name}`,
            meta: `${preview.operations.length} 个操作`,
          },
          {
            state: "done",
            title: `Sources: ${sourceCopy}`,
            meta: result.runId ? `run ${shortRunId(result.runId)}` : "local recipe",
          },
          {
            state: "running",
            title: "等待审批，审批前不会写入本机",
            meta: firstOutput,
          },
        ]);
      }
      addPreviewCard(message, preview.operations, "等待审批");
      addSourcesFooter(message, state.lastSources);
      addApprovalActions(message);
      setMessageStatus(message, "协作 · 等待审批");
      renderInteraction(
        [
          {
            state: "done",
            title: "用户指令",
            detail: prompt,
          },
          {
            state: "done",
            title: "读取本地上下文",
            detail: sourceExcerpt ? `${sourceCopy}: ${sourceExcerpt}` : sourceCopy,
            meta: `${state.lastSources.length} 个来源`,
          },
          {
            state: "done",
            title: `模板：${recipe.name}`,
            detail: recipe.description,
            meta: recipe.output,
          },
          {
            state: "done",
            title: "Sources",
            detail: sourceExcerpt ? `${sourceCopy}: ${sourceExcerpt}` : sourceCopy,
            meta: result.runId ? `run ${shortRunId(result.runId)}` : "local recipe",
          },
          {
            state: "active",
            title: "等待审批",
            detail: `已生成 ${preview.operations.length} 个可审批操作，审批后才会写入本机。`,
            meta: firstOutput,
          },
        ],
        "等待审批",
      );
      await refreshRunCards(result.runId);
      setStatus("计划就绪");
    }

    return { runRecipePlan };
  }

  window.AgentCoworkRecipeRunner = {
    createRecipeRunner,
  };
})();
