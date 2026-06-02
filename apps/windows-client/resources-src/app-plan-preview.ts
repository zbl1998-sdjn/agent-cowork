// Static file:// mode has its own branch so the real Host planning path stays readable.
(function () {
  function renderStaticPlanPreview({
    prompt,
    taskMessage,
    setStatus,
    setArtifact,
    addProgressLines,
    setMessageStatus,
    renderInteraction,
  }: any) {
    setStatus("预览模式");
    setArtifact(`已根据 “${prompt.slice(0, 42)}” 生成本地操作预览，等待审批。`);
    addProgressLines(taskMessage, [
      {
        state: "done",
        title: "静态预览已生成",
      },
      {
        state: "wait",
        title: "通过 localhost 启动后可执行真实本地写入",
      },
    ]);
    setMessageStatus(taskMessage, "协作 · 预览模式");
    renderInteraction(
      [
        {
          state: "done",
          title: "用户指令",
          detail: prompt,
        },
        {
          state: "done",
          title: "静态预览",
          detail: "当前通过 file:// 打开，不能调用 Host API；已展示本地预览状态。",
        },
        {
          state: "wait",
          title: "等待 Host",
          detail: "通过 localhost 启动后可读取文件、调用 Kimi API，并写入审计日志。",
        },
      ],
      "静态预览",
    );
  }

  window.AgentCoworkPlanPreview = {
    renderStaticPlanPreview,
  };
})();
