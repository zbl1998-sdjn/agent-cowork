// 协作规划器负责完整预览流程;app.js 只负责依赖注入。
(function () {
  function createPlanRunner({
    state,
    composer,
    approveButton,
    chatOutput,
    postJson,
    idempotencyKey,
    uniqueStamp,
    joinWin,
    compactText,
    shortRunId,
    setView,
    setStatus,
    setArtifact,
    setRunChip,
    renderInteraction,
    renderOperations,
    shouldClarify,
    showClarification,
    hideClarification,
    shouldUseCowork,
    maybeSelectRecipe,
    activeFiles,
    textCandidate,
    readCandidateSummary,
    tryAgentEnginePlan,
    runRecipePlan,
    sendChatMessage,
    refreshRunCards,
    appendUserMessage,
    appendAssistantMessage,
    addProgressLines,
    addPreviewCard,
    addSourcesFooter,
    addApprovalActions,
    setMessageStatus,
  }: any) {
    const { renderStaticPlanPreview } = window.AgentCoworkPlanPreview;
    async function generatePlan(options: AgentCoworkJson = {}) {
      const { appendUser = true } = options;
      const prompt = composer.value.trim() || "整理这个本地文件夹，生成可审批的安全操作计划";

      if (state.view !== "cowork" && state.view !== "code") {
        chatOutput.hidden = true;
        setView("cowork");
      }
      if (appendUser) {
        appendUserMessage(prompt);
      }
      if (shouldClarify(prompt) && showClarification(prompt)) {
        return;
      }
      hideClarification();
      const taskMessage = appendAssistantMessage("我会先读取可信工作区，再生成需要审批的本地操作预览。", { status: "协作 · 计划中" });
      state.activeTaskMessage = taskMessage;
      addProgressLines(taskMessage, [
        {
          state: "running",
          title: "正在读取本地上下文",
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
            title: "读取本地上下文",
            detail: "正在从可信工作区选择可读取的文本文件，生成给 Agent 的安全摘要。",
          },
        ],
        "正在创建 Cowork 任务",
      );

      if (!state.hostApi) {
        renderStaticPlanPreview({ prompt, taskMessage, setStatus, setArtifact, addProgressLines, setMessageStatus, renderInteraction });
        return;
      }

      const recipe = maybeSelectRecipe(prompt);
      if (recipe) {
        await runRecipePlan(prompt, recipe);
        return;
      }
      setStatus("正在读取工作区");
      const candidate = textCandidate(activeFiles());
      const summary = await readCandidateSummary(candidate);
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
            detail: summary,
            meta: candidate ? candidate.path : "无可读文本文件",
          },
          {
            state: "active",
            title: "调用 Agent 生成计划",
            detail: state.modelApiEnabled ? "正在调用服务端模型 API，输出只作为计划文本，不直接执行本地操作。" : "模型 API 未配置，使用本地摘要生成安全草稿。",
          },
        ],
        "Agent 正在规划",
      );
      addProgressLines(taskMessage, [
        {
          state: "done",
          title: "已读取本地上下文",
          meta: candidate ? candidate.path : "无可读文本文件",
        },
        {
          state: "running",
          title: state.modelApiEnabled ? "正在调用模型 API 生成计划" : "模型 API 未配置，使用本地摘要生成安全草稿",
        },
      ]);
      const agentPlan = await tryAgentEnginePlan(prompt, summary);
      state.lastRun = agentPlan.runId
        ? {
            id: agentPlan.runId,
            path: agentPlan.runPath,
            durationMs: agentPlan.durationMs,
            failed: agentPlan.failed === true,
          }
        : null;
      const now = new Date();
      const id = uniqueStamp(now);
      const outputPath = joinWin(state.workspace, ".AgentCowork", "artifacts", `ui-plan-${id}.md`);
      state.operations = [
        {
          type: "write",
          path: outputPath,
          content: [
            "# Agent Cowork 界面计划",
            "",
            `- 模式: ${state.view}`,
            `- 指令: ${prompt}`,
            `- 工作区: ${state.workspace}`,
            `- 来源摘要: ${summary}`,
            `- 模型 API: ${agentPlan.used ? `已接入，耗时 ${agentPlan.durationMs}ms` : agentPlan.failed ? "调用失败，已安全降级" : "未使用，安全降级"}`,
            `- Run ID: ${agentPlan.runId || "local-fallback"}`,
            `- Run 记录: ${agentPlan.runPath ? agentPlan.runPath.replace(state.workspace, ".") : "未生成"}`,
            `- 生成时间: ${now.toISOString()}`,
            "",
            "## 模型 API 计划",
            "",
            agentPlan.text,
            "",
          ].join("\n"),
        },
      ];
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
      setArtifact(
        agentPlan.used
          ? `已读取本地内容：${summary}；模型 API 已生成计划，运行记录 ${shortRunId(agentPlan.runId)}。`
          : `已读取本地内容：${summary}`,
        outputPath.replace(state.workspace, "."),
      );
      if (agentPlan.used) {
        setRunChip(`模型 API · ${shortRunId(agentPlan.runId)} · ${agentPlan.durationMs}ms`, "ready");
      } else if (agentPlan.failed) {
        setRunChip(`模型 API 失败 · ${shortRunId(agentPlan.runId)}`, "muted");
      }
      addProgressLines(taskMessage, [
        {
          state: agentPlan.failed ? "error" : "done",
          title: agentPlan.used ? "Agent 计划已返回" : agentPlan.failed ? "Agent 调用失败，已降级" : "本地计划已生成",
          meta: agentPlan.runId ? `run ${shortRunId(agentPlan.runId)}` : "local fallback",
        },
        {
          state: "running",
          title: "等待审批，审批前不会写入本机",
          meta: outputPath.replace(state.workspace, "."),
        },
      ]);
      addPreviewCard(taskMessage, preview.operations, "等待审批");
      addSourcesFooter(taskMessage, candidate ? [{ path: candidate.fullPath, relativePath: candidate.path, excerpt: summary }] : []);
      addApprovalActions(taskMessage);
      setMessageStatus(taskMessage, "协作 · 等待审批");
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
            detail: summary,
            meta: candidate ? candidate.path : "无可读文本文件",
          },
          {
            state: agentPlan.failed ? "error" : "done",
            title: agentPlan.used ? "Agent 计划已返回" : agentPlan.failed ? "Agent 调用失败，已降级" : "本地计划已生成",
            detail: compactText(agentPlan.text),
            meta: agentPlan.runId ? `run ${shortRunId(agentPlan.runId)} · ${agentPlan.durationMs || 0}ms` : "local fallback",
          },
          {
            state: "active",
            title: "等待审批",
            detail: `已生成 ${preview.operations.length} 个可审批操作，点击“审批执行”后才会写入本机。`,
            meta: outputPath.replace(state.workspace, "."),
          },
        ],
        "等待审批",
      );
      await refreshRunCards(agentPlan.runId);
      setStatus("计划就绪");
    }

    async function handleComposerSend() {
      const prompt = composer.value.trim();
      if (!prompt) {
        return;
      }
      if (shouldUseCowork(prompt)) {
        await generatePlan({ appendUser: true });
        return;
      }
      await sendChatMessage(prompt);
    }

    return { generatePlan, handleComposerSend };
  }

  window.AgentCoworkPlanRunner = {
    createPlanRunner,
  };
})();
