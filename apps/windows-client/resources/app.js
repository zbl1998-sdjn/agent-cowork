// @ts-nocheck
const state = {
  view: "chat",
  workspace: "C:\\Users\\Administrator\\Desktop\\agent cowork",
  files: [],
  operations: [],
  approved: false,
  hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
  kimiApiEnabled: false,
  lastRun: null,
  runs: [],
  uploadedFiles: [],
  interactionItems: [],
  recipes: [],
  selectedRecipeId: "",
  selectedRecipeSource: "",
  lastSources: [],
  applyIdempotencyKey: "",
  applyApprovalId: "",
  rollbackApprovalId: "",
  activeTaskMessage: null,
  mentionedFiles: [],
  activeEventSource: null,
};

window.agentCowork = state;

const composer = document.querySelector(".composer textarea");
const composerPopover = document.querySelector(".composer-popover");
const uploadInput = document.querySelector(".upload-input");
const folderInput = document.querySelector(".folder-input");
const approveButton = document.querySelector(".approve-button");
const sendButton = document.querySelector(".send-button");
const artifactText = document.querySelector(".artifact-preview p");
const artifactPath = document.querySelector(".artifact-preview code");
const statusText = document.querySelector(".status-text");
const runChip = document.querySelector(".run-chip");
const runSummary = document.querySelector(".run-summary");
const runList = document.querySelector(".run-list");
const runRefreshButton = document.querySelector('[data-action="refresh-runs"]');
const artifactList = document.querySelector("[data-artifact-list]");
const artifactRefreshButton = document.querySelector('[data-action="refresh-artifacts"]');
const workspacePath = document.querySelector(".workspace-card > strong");
const workspaceMeta = document.querySelector(".workspace-card > p");
const fileList = document.querySelector(".file-list");
const operationList = document.querySelector(".operation-list");
const chatOutput = document.querySelector(".chat-output");
const chatOutputText = document.querySelector(".chat-output p");
const conversationTimeline = document.querySelector(".conversation-timeline");
const conversationEmpty = document.querySelector(".conversation-empty");
const workbenchTitle = document.querySelector(".workbench-title");
const workbenchCopy = document.querySelector(".workbench-copy");
const interactionSubtitle = document.querySelector(".interaction-subtitle");
const interactionItems = document.querySelector(".interaction-items");
const recipeSummary = document.querySelector(".recipe-summary");
const recipeList = document.querySelector(".recipe-list");
const recipeClearButton = document.querySelector('[data-action="clear-recipe"]');
const clarifyPanel = document.querySelector(".clarify-panel");
const clarifyOptions = document.querySelector(".clarify-options");

const placeholders = {
  chat: "今天想让 Kimi 做什么？",
  cowork: "选择本地文件夹，描述要让 Agent Cowork 在本机完成的操作",
  code: "描述要让 Kimi 在本地检查的代码任务",
  projects: "搜索或打开一个项目",
  artifacts: "查找产物或审计日志",
  customize: "告诉 Kimi 这个工作区应该如何运行",
};

const {
  arrayBufferToBase64,
  basename,
  compactText,
  formatDuration,
  formatRunTime,
  idempotencyKey,
  joinWin,
  messageStatusClass,
  runStatusText,
  runTypeText,
  shortRunId,
  uniqueStamp,
} = window.AgentCoworkUtils;
const { getJson, postJson } = window.AgentCoworkApi;
const { renderRunEventPayload, subscribeRunEvents } = window.AgentCoworkRunEvents;
const { createArtifactCatalog } = window.AgentCoworkArtifacts;
const { createRunHistoryController } = window.AgentCoworkRunHistory;
const { setArtifact, renderArtifactCatalog, loadArtifactCatalog } = createArtifactCatalog({
  state,
  artifactText,
  artifactPath,
  artifactList,
  getJson,
  basename,
});

const {
  setStatus,
  setRunChip,
  renderInteraction,
  resetInteraction,
  setView,
  summarizeFiles,
  renderFiles,
  renderOperations,
  selectedRecipe,
  renderRecipes,
} = window.AgentCoworkWorkbenchRenderer.createWorkbenchRenderer({
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
});

const {
  textCandidate,
  activeFiles,
  recipeFiles,
  maybeSelectRecipe,
  shouldClarify,
  shouldUseCowork,
  readCandidateSummary,
} = window.AgentCoworkTaskContext.createTaskContext({
  state,
  postJson,
  basename,
  selectedRecipe,
  renderRecipes,
});

const { tryKimiApiPlan, tryKimiChat } = window.AgentCoworkKimiRunner.createKimiRunner({
  state,
  postJson,
  setRunChip,
  setStatus,
  shortRunId,
});

const {
  showChatResponse,
  syncConversationState,
  scrollConversationToEnd,
  setMessageStatus,
  appendUserMessage,
  appendAssistantMessage,
  appendMessageText,
  addProgressLines,
  addPreviewCard,
  markApprovalDone,
  addArtifactCard,
  addSourcesFooter,
  clearConversation,
} = window.AgentCoworkMessageRenderer.createMessageRenderer({
  state,
  composer,
  chatOutput,
  chatOutputText,
  conversationTimeline,
  conversationEmpty,
  messageStatusClass,
  basename,
  compactText,
});

const { approvePlan } = window.AgentCoworkApprovalRunner.createApprovalRunner({
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
});

const { addClarificationCard, addApprovalActions } = window.AgentCoworkMessageActions.createMessageActions({
  state,
  composer,
  renderRecipes,
  hideClarification,
  generatePlan,
  approvePlan,
  setStatus,
  setArtifact,
  setView,
  setMessageStatus,
  appendUserMessage,
  scrollConversationToEnd,
});

const { uploadSelectedFiles } = window.AgentCoworkFileUpload.createFileUploadController({
  state,
  composer,
  postJson,
  arrayBufferToBase64,
  setView,
  setStatus,
  setArtifact,
  refreshWorkspaceTree,
  appendAssistantMessage,
  addArtifactCard,
  renderInteraction,
});

async function loadRecipes() {
  if (!state.hostApi) {
    renderRecipes([]);
    return;
  }
  const payload = await getJson("/api/recipes");
  renderRecipes(payload.recipes || []);
}

async function searchLocalFiles(query) {
  if (!state.hostApi || !query.trim()) {
    return [];
  }
  const payload = await postJson("/api/files/search", {
    trustedRoot: state.workspace,
    query,
    includeContent: true,
    maxResults: 8,
  });
  return payload.results || [];
}

const { renderRunCards, refreshRunCards, selectHistoryRun } = createRunHistoryController({
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
});

const { runRecipePlan } = window.AgentCoworkRecipeRunner.createRecipeRunner({
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
});

const { sendChatMessage } = window.AgentCoworkChatRunner.createChatRunner({
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
});

const composerPopoverController = window.AgentCoworkComposerPopover.createComposerPopover({
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
});
const composerPopoverHandleKey = composerPopoverController.handleKey;

function showClarification(prompt) {
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
      generatePlan({ appendUser: false }).catch((error) => {
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

async function refreshWorkspaceTree() {
  const tree = await postJson("/api/files/tree", { root: state.workspace });
  state.files = tree.files;
  summarizeFiles(tree.files);
  renderFiles(tree.files);
}

async function generatePlan(options = {}) {
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
        detail: "正在从可信工作区选择可读取的文本文件，生成给 Kimi 的安全摘要。",
      },
    ],
    "正在创建 Cowork 任务",
  );

  if (!state.hostApi) {
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
        title: "调用 Kimi 生成计划",
        detail: state.kimiApiEnabled ? "正在调用服务端 Kimi API，输出只作为计划文本，不直接执行本地操作。" : "Kimi API 未配置，使用本地摘要生成安全草稿。",
      },
    ],
    "Kimi 正在规划",
  );
  addProgressLines(taskMessage, [
    {
      state: "done",
      title: "已读取本地上下文",
      meta: candidate ? candidate.path : "无可读文本文件",
    },
    {
      state: "running",
      title: state.kimiApiEnabled ? "正在调用 Kimi API 生成计划" : "Kimi API 未配置，使用本地摘要生成安全草稿",
    },
  ]);
  const kimiPlan = await tryKimiApiPlan(prompt, summary);
  state.lastRun = kimiPlan.runId
    ? {
        id: kimiPlan.runId,
        path: kimiPlan.runPath,
        durationMs: kimiPlan.durationMs,
        failed: kimiPlan.failed === true,
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
        `- Kimi API: ${kimiPlan.used ? `已接入，耗时 ${kimiPlan.durationMs}ms` : kimiPlan.failed ? "调用失败，已安全降级" : "未使用，安全降级"}`,
        `- Run ID: ${kimiPlan.runId || "local-fallback"}`,
        `- Run 记录: ${kimiPlan.runPath ? kimiPlan.runPath.replace(state.workspace, ".") : "未生成"}`,
        `- 生成时间: ${now.toISOString()}`,
        "",
        "## Kimi API 计划",
        "",
        kimiPlan.text,
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
    kimiPlan.used
      ? `已读取本地内容：${summary}；Kimi API 已生成计划，运行记录 ${shortRunId(kimiPlan.runId)}。`
      : `已读取本地内容：${summary}`,
    outputPath.replace(state.workspace, "."),
  );
  if (kimiPlan.used) {
    setRunChip(`Kimi API · ${shortRunId(kimiPlan.runId)} · ${kimiPlan.durationMs}ms`, "ready");
  } else if (kimiPlan.failed) {
    setRunChip(`Kimi API 失败 · ${shortRunId(kimiPlan.runId)}`, "muted");
  }
  addProgressLines(taskMessage, [
    {
      state: kimiPlan.failed ? "error" : "done",
      title: kimiPlan.used ? "Kimi 计划已返回" : kimiPlan.failed ? "Kimi 调用失败，已降级" : "本地计划已生成",
      meta: kimiPlan.runId ? `run ${shortRunId(kimiPlan.runId)}` : "local fallback",
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
        state: kimiPlan.failed ? "error" : "done",
        title: kimiPlan.used ? "Kimi 计划已返回" : kimiPlan.failed ? "Kimi 调用失败，已降级" : "本地计划已生成",
        detail: compactText(kimiPlan.text),
        meta: kimiPlan.runId ? `run ${shortRunId(kimiPlan.runId)} · ${kimiPlan.durationMs || 0}ms` : "local fallback",
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
  await refreshRunCards(kimiPlan.runId);
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

async function loadHostWorkspace() {
  if (!state.hostApi) {
    setStatus("静态预览");
    return;
  }

  try {
    const workspace = await getJson("/api/workspace");
    state.workspace = workspace.trustedRoot;
    state.kimiApiEnabled = workspace.kimiApi?.planEnabled === true || workspace.kimiApi?.chatEnabled === true;
    setRunChip(state.kimiApiEnabled ? "Kimi API 已接入" : "Kimi API 未配置", state.kimiApiEnabled ? "ready" : "muted");
    workspacePath.textContent = state.workspace;

    await refreshWorkspaceTree();
    await loadRecipes();
    await refreshRunCards();
    await loadArtifactCatalog();
    setStatus("本地 Agent 就绪");
  } catch (error) {
    setStatus("Host API 离线");
    setArtifact(`无法连接本地 Host API：${error.message}`);
  }
}

document.querySelectorAll(".mode-tab").forEach((item) => {
  item.addEventListener("click", () => {
    setView(item.dataset.mode);
  });
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    setView(item.dataset.section);
  });
});

document.querySelectorAll("[data-recent]").forEach((item) => {
  item.addEventListener("click", () => {
    setView("chat");
    composer.value = item.dataset.recent;
    showChatResponse(`已打开最近会话：${item.dataset.recent}`);
    appendAssistantMessage(`已打开最近会话：${item.dataset.recent}`, { status: "对话 · 已打开" });
  });
});

document.querySelectorAll("[data-quick]").forEach((item) => {
  item.addEventListener("click", () => {
    const quick = item.dataset.quick;
    const prompts = {
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
  uploadSelectedFiles(uploadInput.files, "上传").catch((error) => {
    setStatus("上传失败");
    setArtifact(error.message);
  }).finally(() => {
    uploadInput.value = "";
  });
});

folderInput?.addEventListener("change", () => {
  uploadSelectedFiles(folderInput.files, "上传文件夹").catch((error) => {
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

document.querySelectorAll("[data-project]").forEach((item) => {
  item.addEventListener("click", () => {
    setView("cowork");
    composer.value = `打开项目：${item.dataset.project}`;
  });
});

document.querySelectorAll("[data-artifact]").forEach((item) => {
  item.addEventListener("click", () => {
    setView("cowork");
    setArtifact(`已选择产物目录：${item.dataset.artifact}`, item.dataset.artifact);
  });
});

sendButton.addEventListener("click", () => {
  handleComposerSend().catch((error) => {
    setStatus("计划失败");
    setArtifact(error.message);
  });
});

composer?.addEventListener("keydown", (event) => {
  if (composerPopoverHandleKey(event)) {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    handleComposerSend().catch((error) => {
      setStatus("计划失败");
      setArtifact(error.message);
    });
  }
});

approveButton.addEventListener("click", () => {
  approvePlan().catch((error) => {
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
  loadArtifactCatalog().catch((error) => {
    setArtifact(`产物列表暂不可用：${error.message}`);
  });
});

setView("chat");
resetInteraction();
renderRunCards([]);
loadHostWorkspace();
