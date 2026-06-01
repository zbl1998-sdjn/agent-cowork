// Classic-script approval runner. It owns the apply/preview-mode execution path
// while app.js keeps only orchestration and event binding.
(function () {
  function createApprovalRunner({
    state,
    approveButton,
    artifactPath,
    postJson,
    idempotencyKey,
    setView,
    setStatus,
    setArtifact,
    renderInteraction,
    renderOperations,
    generatePlan,
    markApprovalDone,
    addProgressLines,
    setMessageStatus,
    addArtifactCard,
    loadArtifactCatalog,
  }) {
    async function approvePlan() {
      if (state.view !== "cowork" && state.view !== "code") {
        setView("cowork");
      }

      if (!state.hostApi) {
        state.approved = true;
        approveButton.textContent = "已审批";
        approveButton.classList.add("is-done");
        setArtifact("预览模式下已完成界面状态切换；通过 localhost 启动可执行真实本地写入。");
        markApprovalDone(state.activeTaskMessage);
        addProgressLines(state.activeTaskMessage, [
          {
            state: "done",
            title: "预览模式已应用",
          },
        ]);
        setMessageStatus(state.activeTaskMessage, "协作 · 预览已应用");
        renderInteraction(
          [
            ...state.interactionItems,
            {
              state: "done",
              title: "预览已应用",
              detail: "静态资源模式下只更新界面状态；真实写入需要通过 localhost Host API 执行。",
            },
          ],
          "预览已应用",
        );
        setStatus("预览已应用");
        return;
      }

      if (state.approved) {
        return;
      }
      if (state.operations.length === 0) {
        await generatePlan();
      }

      setStatus("正在本机执行");
      setMessageStatus(state.activeTaskMessage, "协作 · 正在执行");
      markApprovalDone(state.activeTaskMessage);
      addProgressLines(state.activeTaskMessage, [
        {
          state: "running",
          title: "正在本机执行审批操作",
        },
      ]);
      renderInteraction(
        [
          ...state.interactionItems.map((item) => (item.title === "等待审批" ? { ...item, state: "done", title: "审批已确认" } : item)),
          {
            state: "active",
            title: "正在本机执行",
            detail: "Host 正在按预览列表写入产物，并同步追加审计日志。",
          },
        ],
        "正在执行",
      );
      const applied = await postJson("/api/file-ops/apply", {
        trustedRoot: state.workspace,
        operations: state.operations,
        fileOperationApprovalId: state.applyApprovalId,
        idempotencyKey: state.applyIdempotencyKey || idempotencyKey("apply"),
      });
      state.rollbackApprovalId = applied.rollbackApprovalId || "";
      state.approved = true;
      approveButton.textContent = "已审批";
      approveButton.classList.add("is-done");
      setArtifact(`已在本机执行 ${applied.applied.length} 个审批操作，并写入审计日志。`);
      const artifactPathText = applied.applied[0]?.path?.replace?.(state.workspace, ".") || artifactPath.textContent || ".AgentCowork/artifacts";
      addProgressLines(state.activeTaskMessage, [
        {
          state: "done",
          title: `执行完成：已应用 ${applied.applied.length} 个操作`,
          meta: ".AgentCowork/audit/host-events.jsonl",
        },
      ]);
      addArtifactCard(state.activeTaskMessage, "执行完成", `已在本机执行 ${applied.applied.length} 个审批操作，并写入审计日志。`, artifactPathText);
      setMessageStatus(state.activeTaskMessage, "协作 · 完成");
      renderInteraction(
        [
          ...state.interactionItems.filter((item) => item.title !== "正在本机执行"),
          {
            state: "done",
            title: "执行完成",
            detail: `已应用 ${applied.applied.length} 个操作，产物和审计日志已写入可信工作区。`,
            meta: ".AgentCowork/audit/host-events.jsonl",
          },
        ],
        "执行完成",
      );
      await loadArtifactCatalog().catch(() => {
        // Artifact catalog refresh is best-effort after apply.
      });
      setStatus("已在本机执行");
    }

    return { approvePlan };
  }

  window.AgentCoworkApprovalRunner = {
    createApprovalRunner,
  };
})();
