// @ts-nocheck
// Classic-script workbench renderer. It keeps navigation and side-panel DOM
// updates separate from app.js orchestration.
(function () {
  function createWorkbenchRenderer({
    state,
    composer,
    placeholders,
    statusText,
    runChip,
    workbenchTitle,
    workbenchCopy,
    interactionSubtitle,
    interactionItems,
    workspaceMeta,
    fileList,
    operationList,
    recipeSummary,
    recipeList,
    basename,
    setArtifact,
    loadArtifactCatalog,
  }) {
    function setStatus(text) {
      statusText.textContent = text;
    }

    function setRunChip(text, variant = "muted") {
      if (!runChip) {
        return;
      }
      runChip.textContent = text;
      runChip.classList.toggle("is-ready", variant === "ready");
      runChip.classList.toggle("is-muted", variant === "muted");
    }

    function renderInteraction(items, subtitle = "任务运行中") {
      state.interactionItems = items;
      interactionSubtitle.textContent = subtitle;
      interactionItems.replaceChildren();
      for (const item of items) {
        const row = document.createElement("div");
        row.className = `interaction-row is-${item.state || "wait"}`;

        const dot = document.createElement("span");
        dot.className = "step-dot";

        const body = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = item.title;
        const detail = document.createElement("p");
        detail.textContent = item.detail || "";
        body.append(title, detail);

        if (item.meta) {
          const meta = document.createElement("code");
          meta.textContent = item.meta;
          body.append(meta);
        }

        row.append(dot, body);
        interactionItems.append(row);
      }
    }

    function resetInteraction() {
      renderInteraction(
        [
          {
            state: "wait",
            title: "等待任务",
            detail: "发送后这里会展示 Kimi 的读取、计划、审批和执行过程。",
          },
        ],
        "等待任务输入",
      );
    }

    function setWorkbenchCopy(view) {
      if (view === "code") {
        workbenchTitle.textContent = "Kimi Code";
        workbenchCopy.textContent = "读取当前项目上下文，生成代码任务计划，审批后写入本地产物。";
        return;
      }
      workbenchTitle.textContent = "Agent Cowork";
      workbenchCopy.textContent = "读取本地文件夹、生成操作预览、审批后在本机执行。";
    }

    function setView(view) {
      state.view = view;
      document.body.dataset.view = view;
      composer.placeholder = placeholders[view] || placeholders.chat;

      document.querySelectorAll(".mode-tab").forEach((tab) => {
        const active = tab.dataset.mode === view;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
      });

      document.querySelectorAll(".nav-item").forEach((item) => {
        item.classList.toggle("is-active", item.dataset.section === view);
      });

      document.querySelectorAll(".view-panel").forEach((panel) => {
        const views = (panel.dataset.views || "").split(/\s+/).filter(Boolean);
        const visible = views.includes(view);
        panel.hidden = !visible;
        panel.classList.toggle("is-visible", visible);
      });

      if (view === "cowork" || view === "code") {
        setWorkbenchCopy(view);
      }
      if (view === "artifacts") {
        loadArtifactCatalog().catch((error) => {
          setArtifact(`产物列表暂不可用：${error.message}`);
        });
      }
    }

    function summarizeFiles(files) {
      const docs = files.filter((file) => file.kind === "file").length;
      const dirs = files.filter((file) => file.kind === "directory").length;
      workspaceMeta.textContent = `已发现 ${docs} 个文件、${dirs} 个目录，可读取文本并生成审批操作。`;
    }

    function renderFiles(files) {
      fileList.replaceChildren();
      const visible = files.filter((file) => file.kind === "file").slice(0, 4);
      for (const file of visible) {
        const row = document.createElement("span");
        row.textContent = file.path;
        fileList.append(row);
      }
      if (visible.length === 0) {
        const row = document.createElement("span");
        row.textContent = "当前工作区还没有可展示文件";
        fileList.append(row);
      }
    }

    function renderOperations(operations) {
      operationList.replaceChildren();
      for (const item of operations) {
        const row = document.createElement("div");
        row.className = "diff-row";

        const op = document.createElement("span");
        op.className = item.type === "write" ? "op is-write" : "op";
        op.textContent = item.type;

        const detail = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = basename(item.targetPath || item.path);
        const description = document.createElement("p");
        description.textContent = item.targetPath
          ? `${basename(item.path)} -> ${item.targetPath.replace(state.workspace, ".")}`
          : `写入 ${item.path.replace(state.workspace, ".")}`;

        detail.append(title, description);
        row.append(op, detail);
        operationList.append(row);
      }
    }

    function selectedRecipe() {
      return state.recipes.find((recipe) => recipe.id === state.selectedRecipeId) || null;
    }

    function renderRecipes(recipes) {
      state.recipes = Array.isArray(recipes) ? recipes : [];
      if (!recipeList || !recipeSummary) {
        return;
      }
      recipeList.replaceChildren();
      recipeSummary.textContent = state.recipes.length > 0
        ? `已加载 ${state.recipes.length} 个本地模板，模板输出仍需审批后写入`
        : "模板暂不可用";

      for (const recipe of state.recipes) {
        const card = document.createElement("button");
        card.className = "recipe-card";
        card.type = "button";
        card.dataset.recipeId = recipe.id;
        card.setAttribute("role", "listitem");
        card.classList.toggle("is-active", recipe.id === state.selectedRecipeId);

        const title = document.createElement("strong");
        title.textContent = recipe.name;
        const detail = document.createElement("p");
        detail.textContent = recipe.description;
        const meta = document.createElement("em");
        meta.textContent = recipe.output;
        card.append(title, detail, meta);
        card.addEventListener("click", () => {
          state.selectedRecipeId = recipe.id;
          state.selectedRecipeSource = "manual";
          renderRecipes(state.recipes);
          setView("cowork");
          setStatus(`已选择模板：${recipe.name}`);
          if (!composer.value.trim()) {
            composer.value = `${recipe.name}：读取本地材料并生成可审批产物`;
          }
          composer.focus();
        });
        recipeList.append(card);
      }
    }

    return {
      setStatus,
      setRunChip,
      renderInteraction,
      resetInteraction,
      setWorkbenchCopy,
      setView,
      summarizeFiles,
      renderFiles,
      renderOperations,
      selectedRecipe,
      renderRecipes,
    };
  }

  window.AgentCoworkWorkbenchRenderer = {
    createWorkbenchRenderer,
  };
})();
