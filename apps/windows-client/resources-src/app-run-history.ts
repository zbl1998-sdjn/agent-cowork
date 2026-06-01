// Classic-script run history controller. It owns task-card rendering and
// historical run replay while app.js remains the orchestration layer.
(function () {
  function normalizeRun(run: any) {
    const value = run && typeof run === "object" ? run : {};
    return {
      ...value,
      id: typeof value.id === "string" ? value.id : "",
      status: typeof value.status === "string" ? value.status : "running",
      prompt: typeof value.prompt === "string" ? value.prompt : "",
      runPath: typeof value.runPath === "string" ? value.runPath : "",
      durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
      finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : "",
      trustedRoot: typeof value.trustedRoot === "string" ? value.trustedRoot : "",
      recipeId: typeof value.recipeId === "string" ? value.recipeId : "",
      promptPreview: typeof value.promptPreview === "string" ? value.promptPreview : "",
    };
  }

  function createRunHistoryController({
    state,
    composer,
    runList,
    runSummary,
    getJson,
    compactText,
    formatDuration,
    formatRunTime,
    renderRunEventPayload,
    renderInteraction,
    renderRecipes,
    setStatus,
    setArtifact,
    setRunChip,
    appendAssistantMessage,
    scrollConversationToEnd,
    runStatusText,
    runTypeText,
    shortRunId,
  }: any) {
    function renderRunCards(runs: any, activeRunId: any = state.lastRun?.id) {
      state.runs = Array.isArray(runs) ? runs.map(normalizeRun) : [];
      if (!runList || !runSummary) {
        return;
      }

      runList.replaceChildren();
      runSummary.textContent = state.hostApi
        ? state.runs.length > 0
          ? `最近 ${state.runs.length} 次 Kimi 任务，点击可查看输入和结果`
          : "暂无 Kimi 运行记录"
        : "静态预览模式不会读取运行记录";

      if (state.runs.length === 0) {
        const empty = document.createElement("button");
        empty.className = "run-card is-empty";
        empty.type = "button";
        empty.setAttribute("role", "listitem");
        empty.innerHTML = "<span>暂无运行记录</span><strong>发送任务后这里会展示 Kimi 运行卡片</strong><em>等待任务</em>";
        runList.append(empty);
        return;
      }

      for (const run of state.runs.slice(0, 6)) {
        const card = document.createElement("button");
        card.className = `run-card is-${run.status || "running"}`;
        card.type = "button";
        card.dataset.runId = run.id;
        card.setAttribute("role", "listitem");
        card.classList.toggle("is-active", run.id === activeRunId);

        const top = document.createElement("span");
        top.textContent = `${runTypeText(run)} · ${runStatusText(run.status)}`;

        const title = document.createElement("strong");
        title.textContent = compactText(run.prompt || "未记录任务输入", 64);

        const meta = document.createElement("em");
        meta.textContent = `${shortRunId(run.id)} · ${formatDuration(run.durationMs)} · ${formatRunTime(run.finishedAt || run.startedAt)}`;

        card.append(top, title, meta);
        card.addEventListener("click", () => {
          showRunDetail(run.id).catch((error: any) => {
            setStatus("任务记录读取失败");
            setArtifact(error.message);
          });
        });
        runList.append(card);
      }
    }

    async function loadRunCards(activeRunId: any = state.lastRun?.id) {
      if (!state.hostApi) {
        renderRunCards([], activeRunId);
        return;
      }
      const payload = await getJson("/api/runs?limit=6");
      renderRunCards(payload && Array.isArray(payload.runs) ? payload.runs : [], activeRunId);
    }

    async function refreshRunCards(activeRunId: any = state.lastRun?.id) {
      try {
        await loadRunCards(activeRunId);
      } catch (error: any) {
        if (runSummary) {
          runSummary.textContent = `运行记录暂不可用：${error.message}`;
        }
      }
    }

    async function showRunDetail(runId: any) {
      if (!state.hostApi || !runId) {
        return;
      }
      const run = normalizeRun(await getJson(`/api/runs/${encodeURIComponent(runId)}`));

      const failed = run.status === "failed";
      renderRunCards(state.runs, run.id);
      renderInteraction(
        [
          {
            state: failed ? "error" : "done",
            title: `${runTypeText(run)}任务 ${runStatusText(run.status)}`,
            detail: run.input?.prompt || "未记录任务输入",
            meta: `run ${shortRunId(run.id)} · ${formatDuration(run.durationMs)}`,
          },
          {
            state: "done",
            title: "本地摘要",
            detail: compactText(run.input?.summary || "未记录摘要"),
            meta: run.trustedRoot || state.workspace,
          },
          {
            state: failed ? "error" : "done",
            title: failed ? "错误信息" : "Kimi 输出",
            detail: compactText(failed ? run.error?.message : run.result?.text, 260),
            meta: formatRunTime(run.finishedAt || run.startedAt),
          },
        ],
        failed ? "任务失败" : "任务详情",
      );
      setStatus(failed ? "任务记录失败" : "任务记录已打开");
      setArtifact(
        failed ? `任务 ${shortRunId(run.id)} 调用失败：${run.error?.message || "未知错误"}` : `已打开任务 ${shortRunId(run.id)} 的 Kimi 输出。`,
        run.id,
      );
    }

    function replayRunEvents(message: any, run: any) {
      if (!message?.body) {
        return;
      }
      const list = document.createElement("div");
      list.className = "message-progress message-progress-sse";
      message.body.append(list);

      const appendLine = (lineState: any, title: any, meta: any) => {
        const row = document.createElement("div");
        row.className = `progress-line is-${lineState || "wait"}`;
        row.textContent = meta ? `${title} · ${meta}` : title;
        list.append(row);
        scrollConversationToEnd();
      };

      let rendered = 0;
      for (const event of Array.isArray(run?.events) ? run.events : []) {
        if (event && typeof event === "object" && renderRunEventPayload(event.type, event, appendLine)) {
          rendered += 1;
        }
      }
      if (rendered === 0) {
        appendLine("wait", "这条历史任务没有可回放事件", "已打开详情");
      }
    }

    async function selectHistoryRun(indexRun: any) {
      const index = normalizeRun(indexRun);
      if (!state.hostApi || !index.id) {
        return;
      }
      const run = normalizeRun(await getJson(`/api/runs/${encodeURIComponent(index.id)}`));
      renderRunCards(state.runs, run.id);
      state.lastRun = {
        id: run.id,
        path: run.runPath || index.runPath || "",
        durationMs: run.durationMs || index.durationMs || 0,
        failed: run.status === "failed",
      };
      if (run.recipeId) {
        state.selectedRecipeId = run.recipeId;
        state.selectedRecipeSource = "history";
        renderRecipes(state.recipes);
      }
      const prompt = run.input?.prompt || index.promptPreview || "";
      if (prompt) {
        composer.value = prompt;
      }
      const message = appendAssistantMessage(`回放历史任务 ${shortRunId(run.id)}。`, {
        status: run.status === "failed" ? "历史 · 失败" : "历史 · 回放中",
      });
      replayRunEvents(message, run);
      renderInteraction(
        [
          {
            state: run.status === "failed" ? "error" : "done",
            title: `${runTypeText(run)}任务 ${runStatusText(run.status)}`,
            detail: prompt || "未记录任务输入",
            meta: `run ${shortRunId(run.id)} · ${formatDuration(run.durationMs)}`,
          },
        ],
        "历史任务",
      );
      setStatus("历史任务已回放");
      setRunChip(`历史任务 · ${shortRunId(run.id)}`, "ready");
    }

    return {
      renderRunCards,
      refreshRunCards,
      selectHistoryRun,
    };
  }

  window.AgentCoworkRunHistory = {
    createRunHistoryController,
  };
})();
