// Event binding is isolated from controller construction to keep app.js readable.
(function () {
  function bindAppEvents({
    state,
    composer,
    uploadInput,
    folderInput,
    approveButton,
    sendButton,
    runRefreshButton,
    artifactRefreshButton,
    chatOutput,
    setView,
    setStatus,
    setArtifact,
    showChatResponse,
    appendAssistantMessage,
    resetInteraction,
    uploadSelectedFiles,
    handleComposerSend,
    approvePlan,
    refreshRunCards,
    loadArtifactCatalog,
    composerPopoverHandleKey,
  }: any) {
    document.querySelectorAll<HTMLElement>(".mode-tab").forEach((item: any) => {
      item.addEventListener("click", () => {
        setView(item.dataset.mode);
      });
    });

    document.querySelectorAll<HTMLElement>(".nav-item").forEach((item: any) => {
      item.addEventListener("click", () => {
        setView(item.dataset.section);
      });
    });

    document.querySelectorAll<HTMLElement>("[data-recent]").forEach((item: any) => {
      item.addEventListener("click", () => {
        setView("chat");
        composer.value = item.dataset.recent;
        showChatResponse(`已打开最近会话：${item.dataset.recent}`);
        appendAssistantMessage(`已打开最近会话：${item.dataset.recent}`, { status: "对话 · 已打开" });
      });
    });

    document.querySelectorAll<HTMLElement>("[data-quick]").forEach((item: any) => {
      item.addEventListener("click", () => {
        const quick = item.dataset.quick;
        const prompts: Record<string, string> = {
          code: "检查当前项目，列出可以安全修改的文件和测试命令",
          learn: "帮我用简洁方式讲清楚这个复杂主题",
          write: "帮我起草一版结构清晰的文档",
          choice: "根据当前上下文，帮我选择下一步最有价值的任务",
          "local-folder": "读取上传文件夹，生成可审批的整理计划",
        };
        composer.value = prompts[quick] || "";
        setView(quick === "code" ? "code" : quick === "local-folder" ? "cowork" : "chat");
        if (quick === "local-folder") {
          folderInput?.click();
          return;
        }
        composer.focus();
      });
    });

    document.querySelector('[data-action="upload-files"]')?.addEventListener("click", () => {
      setView("cowork");
      uploadInput?.click();
      composer.focus();
    });

    uploadInput?.addEventListener("change", () => {
      uploadSelectedFiles(uploadInput.files, "上传").catch((error: any) => {
        setStatus("上传失败");
        setArtifact(error.message);
      }).finally(() => {
        uploadInput.value = "";
      });
    });

    folderInput?.addEventListener("change", () => {
      uploadSelectedFiles(folderInput.files, "上传文件夹").catch((error: any) => {
        setStatus("上传失败");
        setArtifact(error.message);
      }).finally(() => {
        folderInput.value = "";
      });
    });

    document.querySelector('[data-action="new-chat"]')?.addEventListener("click", () => {
      setView("chat");
      composer.value = "";
      if (typeof chatOutput !== "undefined" && chatOutput) {
        chatOutput.hidden = true;
      }
      state.operations = [];
      state.approved = false;
      if (state.activeEventSource) {
        try {
          state.activeEventSource.close();
        } catch {
          // ignore
        }
        state.activeEventSource = null;
      }
      resetInteraction();
      approveButton.textContent = "审批执行";
      approveButton.classList.remove("is-done");
    });

    document.querySelectorAll<HTMLElement>("[data-project]").forEach((item: any) => {
      item.addEventListener("click", () => {
        setView("cowork");
        composer.value = `打开项目：${item.dataset.project}`;
      });
    });

    document.querySelectorAll<HTMLElement>("[data-artifact]").forEach((item: any) => {
      item.addEventListener("click", () => {
        setView("cowork");
        setArtifact(`已选择产物目录：${item.dataset.artifact}`, item.dataset.artifact);
      });
    });

    sendButton.addEventListener("click", () => {
      handleComposerSend().catch((error: any) => {
        setStatus("计划失败");
        setArtifact(error.message);
      });
    });

    composer?.addEventListener("keydown", (event: any) => {
      if (composerPopoverHandleKey(event)) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleComposerSend().catch((error: any) => {
          setStatus("计划失败");
          setArtifact(error.message);
        });
      }
    });

    approveButton.addEventListener("click", () => {
      approvePlan().catch((error: any) => {
        setStatus("执行受阻");
        setArtifact(error.message);
      });
    });

    runRefreshButton?.addEventListener("click", () => {
      refreshRunCards().catch(() => {
        // refreshRunCards owns the visible error state.
      });
    });

    artifactRefreshButton?.addEventListener("click", () => {
      loadArtifactCatalog().catch((error: any) => {
        setArtifact(`产物列表暂不可用：${error.message}`);
      });
    });
  }

  function bootstrapApp({ setView, resetInteraction, renderRunCards, loadHostWorkspace }: any) {
    setView("chat");
    resetInteraction();
    renderRunCards([]);
    loadHostWorkspace();
  }

  window.AgentCoworkAppEvents = {
    bindAppEvents,
    bootstrapApp,
  };
})();
