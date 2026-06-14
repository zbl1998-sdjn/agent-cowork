// 澄清 UI 与计划生成解耦,只通过回调把用户选择交回规划流程。
(function () {
  function createClarificationController({
    state,
    composer,
    clarifyPanel,
    clarifyOptions,
    renderRecipes,
    setStatus,
    setArtifact,
    renderInteraction,
    appendUserMessage,
    appendAssistantMessage,
    addClarificationCard,
    generatePlan,
  }: any) {
    function showClarification(prompt: any) {
      if (!clarifyPanel || !clarifyOptions) {
        return false;
      }
      clarifyOptions.replaceChildren();
      const options = [
        { recipeId: "folder-organize", title: "整理文件夹", detail: "只生成整理计划，不直接移动文件。" },
        { recipeId: "meeting-actions", title: "提取行动项", detail: "适合会议纪要、待办和负责人。" },
        { recipeId: "summary-report", title: "生成总结", detail: "把本地材料汇总成报告。" },
      ];
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.innerHTML = `<strong>${option.title}</strong><span>${option.detail}</span>`;
        button.addEventListener("click", () => {
          state.selectedRecipeId = option.recipeId;
          state.selectedRecipeSource = "clarify";
          clarifyPanel.hidden = true;
          renderRecipes(state.recipes);
          composer.value = `${prompt}，按“${option.title}”执行`;
          appendUserMessage(`我选择：${option.title}`);
          generatePlan({ appendUser: false }).catch((error: any) => {
            setStatus("计划失败");
            setArtifact(error.message);
          });
        });
        clarifyOptions.append(button);
      }
      clarifyPanel.hidden = false;
      setStatus("等待澄清");
      renderInteraction(
        [
          {
            state: "done",
            title: "用户指令",
            detail: prompt,
          },
          {
            state: "active",
            title: "需要澄清",
            detail: "指令较宽泛，先选择一个任务模板再生成可审批操作。",
          },
        ],
        "等待用户选择",
      );
      const message = appendAssistantMessage("我需要先确认你要我按哪种方式处理。", { status: "协作 · 等待澄清" });
      state.activeTaskMessage = message;
      addClarificationCard(message, prompt, options);
      return true;
    }

    function hideClarification() {
      if (clarifyPanel) {
        clarifyPanel.hidden = true;
      }
    }

    return {
      showClarification,
      hideClarification,
    };
  }

  window.AgentCoworkClarification = {
    createClarificationController,
  };
})();
