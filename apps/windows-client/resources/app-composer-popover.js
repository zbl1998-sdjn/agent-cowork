(function () {
  function createComposerPopover({
    state,
    composer,
    composerPopover,
    searchLocalFiles,
    renderRecipes,
    selectHistoryRun,
    setStatus,
    setArtifact,
    getJson,
    basename,
    compactText,
    runStatusText,
    runTypeText,
    shortRunId,
  }) {
    const composerPopoverState = { open: false, mode: null, items: [], active: 0, triggerStart: 0 };
    let mentionSearchToken = 0;
    let historySearchToken = 0;

    function hideComposerPopover() {
      composerPopoverState.open = false;
      composerPopoverState.mode = null;
      composerPopoverState.items = [];
      composerPopoverState.active = 0;
      if (composerPopover) {
        composerPopover.hidden = true;
        composerPopover.replaceChildren();
      }
    }

    function renderComposerPopover() {
      if (!composerPopover) {
        return;
      }
      composerPopover.replaceChildren();
      if (composerPopoverState.items.length === 0) {
        hideComposerPopover();
        return;
      }
      const header = document.createElement("div");
      header.className = "popover-header";
      const headerLabels = {
        template: "选择任务模板",
        mention: "引用本地文件",
        history: "历史任务",
      };
      header.textContent = headerLabels[composerPopoverState.mode] || "选择建议";
      composerPopover.append(header);
      composerPopoverState.items.forEach((item, index) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `popover-item${index === composerPopoverState.active ? " is-active" : ""}`;
        const title = document.createElement("strong");
        title.textContent = item.title;
        const detail = document.createElement("span");
        detail.textContent = item.detail || "";
        row.append(title, detail);
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
          selectComposerPopoverItem(index);
        });
        composerPopover.append(row);
      });
      composerPopover.hidden = false;
      composerPopoverState.open = true;
    }

    function detectComposerTrigger() {
      const value = composer.value;
      const caret = composer.selectionStart ?? value.length;
      const before = value.slice(0, caret);
      const slashMatch = before.match(/(?:^|\n)\/([^\s/]*)$/);
      if (slashMatch) {
        return { mode: "template", query: slashMatch[1], start: before.length - slashMatch[1].length - 1 };
      }
      const atMatch = before.match(/@([^\s@]*)$/);
      if (atMatch) {
        return { mode: "mention", query: atMatch[1], start: before.length - atMatch[1].length - 1 };
      }
      const historyMatch = before.match(/#([^\s#]*)$/);
      if (historyMatch) {
        return { mode: "history", query: historyMatch[1], start: before.length - historyMatch[1].length - 1 };
      }
      return null;
    }

    function templateItems(query) {
      const q = String(query || "").toLowerCase();
      return state.recipes
        .filter((recipe) => !q || `${recipe.name} ${recipe.id} ${recipe.summary || ""}`.toLowerCase().includes(q))
        .slice(0, 6)
        .map((recipe) => ({ kind: "template", id: recipe.id, title: recipe.name, detail: recipe.summary || recipe.id, recipe }));
    }

    async function refreshMentionItems(query) {
      const token = ++mentionSearchToken;
      let results = [];
      try {
        results = await searchLocalFiles(query);
      } catch {
        results = [];
      }
      if (token !== mentionSearchToken || composerPopoverState.mode !== "mention") {
        return;
      }
      composerPopoverState.items = results.slice(0, 8).map((file) => ({
        kind: "mention",
        title: file.path,
        detail: file.excerpt ? compactText(file.excerpt, 60) : (file.extension || "file"),
        file: { path: file.path, fullPath: file.fullPath, kind: "file", size: file.size },
      }));
      composerPopoverState.active = 0;
      renderComposerPopover();
    }

    async function historyRunItems(query) {
      if (!state.hostApi) {
        return [];
      }
      const payload = await getJson("/api/runs/index?limit=20");
      const q = String(query || "").toLowerCase();
      return (payload.runs || [])
        .filter((run) => {
          if (!q) {
            return true;
          }
          return [
            run.id,
            run.promptPreview,
            run.recipeId,
            run.status,
            run.type,
            run.mode,
          ].filter(Boolean).join(" ").toLowerCase().includes(q);
        })
        .slice(0, 8)
        .map((run) => ({
          kind: "history",
          id: run.id,
          title: `${runTypeText(run)} · ${runStatusText(run.status)} · ${shortRunId(run.id)}`,
          detail: compactText(run.promptPreview || run.recipeId || run.type || "历史任务", 80),
          run,
        }));
    }

    async function refreshHistoryRunItems(query) {
      const token = ++historySearchToken;
      let results = [];
      try {
        results = await historyRunItems(query);
      } catch {
        results = [];
      }
      if (token !== historySearchToken || composerPopoverState.mode !== "history") {
        return;
      }
      composerPopoverState.items = results;
      composerPopoverState.active = 0;
      renderComposerPopover();
    }

    function replaceTriggerToken(start, insertText) {
      const value = composer.value;
      const caret = composer.selectionStart ?? value.length;
      composer.value = value.slice(0, start) + insertText + value.slice(caret);
      const next = start + insertText.length;
      composer.setSelectionRange(next, next);
    }

    function selectComposerPopoverItem(index) {
      const item = composerPopoverState.items[index];
      if (!item) {
        return;
      }
      if (item.kind === "template") {
        state.selectedRecipeId = item.id;
        state.selectedRecipeSource = "slash";
        renderRecipes(state.recipes);
        composer.value = `${item.title}：读取本地材料并生成可审批产物`;
      } else if (item.kind === "mention") {
        const key = item.file.fullPath || item.file.path;
        if (!state.mentionedFiles.some((file) => (file.fullPath || file.path) === key)) {
          state.mentionedFiles.push(item.file);
        }
        replaceTriggerToken(composerPopoverState.triggerStart, `@${basename(item.file.path)} `);
      } else if (item.kind === "history") {
        replaceTriggerToken(composerPopoverState.triggerStart, `#${shortRunId(item.id)} `);
        selectHistoryRun(item.run).catch((error) => {
          setStatus("历史任务读取失败");
          setArtifact(error.message);
        });
      }
      hideComposerPopover();
      composer.focus();
    }

    function handleComposerInput() {
      const trigger = detectComposerTrigger();
      if (!trigger) {
        hideComposerPopover();
        return;
      }
      composerPopoverState.mode = trigger.mode;
      composerPopoverState.triggerStart = trigger.start;
      if (trigger.mode === "template") {
        composerPopoverState.items = templateItems(trigger.query);
        composerPopoverState.active = 0;
        renderComposerPopover();
        return;
      }
      if (trigger.mode === "history") {
        refreshHistoryRunItems(trigger.query);
        return;
      }
      if (!trigger.query) {
        hideComposerPopover();
        return;
      }
      refreshMentionItems(trigger.query);
    }

    function isComposerPopoverOpen() {
      return composerPopoverState.open;
    }

    function composerPopoverHandleKey(event) {
      if (!composerPopoverState.open || composerPopoverState.items.length === 0) {
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideComposerPopover();
        return true;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        composerPopoverState.active = (composerPopoverState.active + 1) % composerPopoverState.items.length;
        renderComposerPopover();
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        composerPopoverState.active = (composerPopoverState.active - 1 + composerPopoverState.items.length) % composerPopoverState.items.length;
        renderComposerPopover();
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        selectComposerPopoverItem(composerPopoverState.active);
        return true;
      }
      return false;
    }

    composer?.addEventListener("input", handleComposerInput);
    composer?.addEventListener("blur", () => {
      setTimeout(hideComposerPopover, 120);
    });

    return {
      handleInput: handleComposerInput,
      handleKey: composerPopoverHandleKey,
      hide: hideComposerPopover,
      isOpen: isComposerPopoverOpen,
    };
  }

  window.AgentCoworkComposerPopover = { createComposerPopover };
})();
