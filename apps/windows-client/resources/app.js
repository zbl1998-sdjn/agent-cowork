const state = {
  view: "chat",
  workspace: "C:\\Users\\Administrator\\Desktop\\kimi cowork",
  files: [],
  operations: [],
  approved: false,
  hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
  kimiCliPlanEnabled: false,
  lastRun: null,
  runs: [],
  uploadedFiles: [],
  interactionItems: [],
  recipes: [],
  selectedRecipeId: "",
  selectedRecipeSource: "",
  lastSources: [],
  applyIdempotencyKey: "",
  activeTaskMessage: null,
  mentionedFiles: [],
  activeEventSource: null,
};

window.kimiCowork = state;

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
  cowork: "选择本地文件夹，描述要让 Kimi Cowork 在本机完成的操作",
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
} = window.KimiCoworkUtils;
const { getJson, postJson } = window.KimiCoworkApi;
const { renderRunEventPayload, subscribeRunEvents } = window.KimiCoworkRunEvents;

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

function setArtifact(message, pathText = artifactPath.textContent) {
  artifactText.textContent = message;
  artifactPath.textContent = pathText;
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
  workbenchTitle.textContent = "Kimi Cowork";
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

const composerPopoverController = window.KimiCoworkComposerPopover.createComposerPopover({
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

function textCandidate(files) {
  return files.find((file) => /\.(md|txt|csv|docx|xlsx|pptx|pdf)$/i.test(file.path)) || files.find((file) => file.kind === "file");
}

function activeFiles() {
  return [...state.mentionedFiles, ...state.uploadedFiles, ...state.files];
}

function recipeFiles() {
  const seen = new Set();
  return activeFiles()
    .filter((file) => file.kind === "file")
    .filter((file) => /\.(md|txt|csv|docx|xlsx|pptx|pdf|json|log)$/i.test(file.path))
    .filter((file) => {
      const key = file.fullPath || file.path;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function inferRecipeId(prompt) {
  const text = String(prompt || "").toLowerCase();
  const pairs = [
    ["meeting-actions", /会议|纪要|行动项|待办|todo|meeting/],
    ["excel-cleaning", /表格|清洗|excel|xlsx|csv|数据/],
    ["reimbursement", /报销|发票|费用|invoice|金额/],
    ["contract-summary", /合同|条款|付款|续约|contract/],
    ["feedback-clusters", /反馈|评价|投诉|建议|聚类/],
    ["summary-report", /总结|周报|报告|汇总/],
    ["email-draft", /邮件|email|回复|发送/],
    ["folder-organize", /文件夹|整理|归档|分类/],
  ];
  return pairs.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function maybeSelectRecipe(prompt) {
  if (state.selectedRecipeId && state.selectedRecipeSource !== "auto") {
    return selectedRecipe();
  }
  const inferred = inferRecipeId(prompt);
  if (inferred) {
    state.selectedRecipeId = inferred;
    state.selectedRecipeSource = "auto";
    renderRecipes(state.recipes);
    return selectedRecipe();
  }
  if (state.selectedRecipeSource === "auto") {
    state.selectedRecipeId = "";
    state.selectedRecipeSource = "";
    renderRecipes(state.recipes);
  }
  return null;
}

function shouldClarify(prompt) {
  const text = String(prompt || "").trim();
  return !state.selectedRecipeId && text.length > 0 && text.length <= 12 && /整理|处理|看看|弄一下|做一下/.test(text);
}

function shouldUseCowork(prompt) {
  const text = String(prompt || "").trim();
  if (state.view === "cowork" || state.view === "code") {
    return true;
  }
  if (state.uploadedFiles.length > 0 || state.selectedRecipeId) {
    return true;
  }
  return /本地|工作区|文件|文件夹|目录|上传|读取|整理|归档|审批|执行|生成|写入|移动|重命名|合同|会议|纪要|行动项|报销|发票|表格|清洗|xlsx|csv|docx|pptx|pdf|代码|项目/i.test(text);
}

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

async function readCandidateSummary(candidate) {
  if (!candidate) {
    return "当前工作区没有可读取的文本文件，先生成一个本地审批产物。";
  }
  try {
    const read = await postJson("/api/files/extract", {
      trustedRoot: state.workspace,
      path: candidate.fullPath,
      maxSize: 1024 * 1024,
    });
    return read.content.replace(/\s+/g, " ").slice(0, 180);
  } catch (error) {
    try {
      const read = await postJson("/api/files/read", {
        trustedRoot: state.workspace,
        path: candidate.fullPath,
        maxSize: 1600,
      });
      return read.content.replace(/\s+/g, " ").slice(0, 180);
    } catch {
      return `文件 ${candidate.path} 暂不可直接读取：${error.message}`;
    }
  }
}

function showChatResponse(message) {
  chatOutput.hidden = false;
  chatOutputText.textContent = message;
}

function syncConversationState() {
  const hasMessages = conversationTimeline?.querySelector(".message-bubble") !== null;
  document.body.classList.toggle("has-conversation", hasMessages);
  if (conversationEmpty) {
    conversationEmpty.classList.toggle("is-hidden", hasMessages);
  }
}

function scrollConversationToEnd() {
  syncConversationState();
  requestAnimationFrame(() => {
    const target = conversationTimeline?.lastElementChild || composer;
    target?.scrollIntoView({ block: "end", behavior: "smooth" });
  });
}

function setMessageStatus(message, status) {
  if (!message?.statusEl) {
    return;
  }
  message.statusEl.textContent = status;
  message.statusEl.className = `message-status ${messageStatusClass(status)}`.trim();
}

function appendMessage(role, text, { status = "", meta = "" } = {}) {
  if (!conversationTimeline) {
    return null;
  }
  const bubble = document.createElement("article");
  bubble.className = `message-bubble is-${role}`;

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "D" : "K";

  const card = document.createElement("div");
  card.className = "message-card";

  const header = document.createElement("div");
  header.className = "message-header";
  const name = document.createElement("strong");
  name.textContent = role === "user" ? "Derrick" : "Kimi";
  const right = document.createElement("span");
  if (status) {
    right.className = `message-status ${messageStatusClass(status)}`.trim();
    right.textContent = status;
  } else {
    right.className = "message-meta";
    right.textContent = meta || new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  header.append(name, right);

  const body = document.createElement("div");
  body.className = "message-body";
  if (text) {
    const paragraph = document.createElement("p");
    paragraph.className = "message-text";
    paragraph.textContent = text;
    body.append(paragraph);
  }

  card.append(header, body);
  bubble.append(avatar, card);
  conversationTimeline.append(bubble);

  const message = { bubble, card, body, statusEl: status ? right : null };
  scrollConversationToEnd();
  return message;
}

function appendUserMessage(text) {
  return appendMessage("user", text);
}

function appendAssistantMessage(text, options = {}) {
  return appendMessage("assistant", text, options);
}

function appendMessageText(message, text) {
  if (!message?.body || !text) {
    return;
  }
  const paragraph = document.createElement("p");
  paragraph.className = "message-text";
  paragraph.textContent = text;
  message.body.append(paragraph);
  scrollConversationToEnd();
}

function addProgressLines(message, items) {
  if (!message?.body || !Array.isArray(items) || items.length === 0) {
    return;
  }
  const list = document.createElement("div");
  list.className = "message-progress";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `progress-line is-${item.state || "wait"}`;
    row.textContent = item.meta ? `${item.title} · ${item.meta}` : item.title;
    list.append(row);
  }
  message.body.append(list);
  scrollConversationToEnd();
}

function addClarificationCard(message, prompt, options) {
  if (!message?.body) {
    return;
  }
  const card = document.createElement("div");
  card.className = "clarification-card";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "需要确认执行方向";
  header.append(title);
  const copy = document.createElement("p");
  copy.className = "message-text";
  copy.textContent = "这条指令比较宽泛，先选一个方向，我再生成可审批的本地操作。";
  const choices = document.createElement("div");
  choices.className = "clarification-options";
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    const choiceTitle = document.createElement("strong");
    choiceTitle.textContent = option.title;
    const detail = document.createElement("span");
    detail.textContent = option.detail;
    button.append(choiceTitle, detail);
    button.addEventListener("click", () => {
      choices.querySelectorAll("button").forEach((node) => {
        node.disabled = true;
      });
      state.selectedRecipeId = option.recipeId;
      state.selectedRecipeSource = "clarify";
      hideClarification();
      renderRecipes(state.recipes);
      composer.value = `${prompt}，按“${option.title}”执行`;
      appendUserMessage(`我选择：${option.title}`);
      setMessageStatus(message, "协作 · 已澄清");
      generatePlan({ appendUser: false }).catch((error) => {
        setStatus("计划失败");
        setArtifact(error.message);
      });
    });
    choices.append(button);
  }
  card.append(header, copy, choices);
  message.body.append(card);
  scrollConversationToEnd();
}

function addPreviewCard(message, operations, summary = "等待审批") {
  if (!message?.body) {
    return;
  }
  const card = document.createElement("div");
  card.className = "inline-preview";
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "操作预览";
  const badge = document.createElement("em");
  badge.textContent = summary;
  header.append(title, badge);
  card.append(header);
  for (const item of (operations || []).slice(0, 4)) {
    const row = document.createElement("div");
    row.className = "inline-op";
    const type = document.createElement("span");
    type.textContent = item.type;
    type.classList.toggle("is-write", item.type === "write");
    const detail = document.createElement("p");
    detail.textContent = (item.targetPath || item.path || "").replace(state.workspace, ".") || "待执行操作";
    row.append(type, detail);
    card.append(row);
  }
  if ((operations || []).length > 4) {
    const more = document.createElement("p");
    more.textContent = `另有 ${(operations || []).length - 4} 个操作会在审批后执行。`;
    card.append(more);
  }
  message.body.append(card);
  scrollConversationToEnd();
}

function addApprovalActions(message) {
  if (!message?.body) {
    return;
  }
  message.actionsEl?.remove();
  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary";
  approve.textContent = "审批执行";
  approve.addEventListener("click", () => {
    approvePlan().catch((error) => {
      setStatus("执行受阻");
      setArtifact(error.message);
      setMessageStatus(message, "协作 · 执行受阻");
    });
  });
  const diff = document.createElement("button");
  diff.type = "button";
  diff.textContent = "查看预览";
  diff.addEventListener("click", () => {
    setView("cowork");
    document.querySelector(".operations-card")?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  const reject = document.createElement("button");
  reject.type = "button";
  reject.textContent = "拒绝";
  reject.addEventListener("click", () => {
    actions.className = "approval-actions is-done";
    actions.textContent = "已拒绝，本次不会写入本机。";
    setMessageStatus(message, "协作 · 已拒绝");
    setStatus("已拒绝");
  });
  actions.append(approve, diff, reject);
  message.actionsEl = actions;
  message.body.append(actions);
  scrollConversationToEnd();
}

function markApprovalDone(message) {
  if (!message?.actionsEl) {
    return;
  }
  message.actionsEl.className = "approval-actions is-done";
  message.actionsEl.textContent = `已审批 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

function addArtifactCard(message, title, description, pathText) {
  if (!message?.body) {
    return;
  }
  const card = document.createElement("div");
  card.className = "inline-artifact";
  const header = document.createElement("header");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const meta = document.createElement("em");
  meta.textContent = "本地产物";
  header.append(strong, meta);
  const copy = document.createElement("p");
  copy.textContent = description;
  const pathLine = document.createElement("p");
  pathLine.textContent = pathText || ".KimiCowork/artifacts";
  card.append(header, copy, pathLine);
  message.body.append(card);
  scrollConversationToEnd();
}

function addSourcesFooter(message, sources) {
  if (!message?.body || !Array.isArray(sources) || sources.length === 0) {
    return;
  }
  const card = document.createElement("div");
  card.className = "inline-sources";
  const header = document.createElement("header");
  const strong = document.createElement("strong");
  strong.textContent = `来源 (${sources.length})`;
  const meta = document.createElement("em");
  meta.textContent = "可信工作区";
  header.append(strong, meta);
  card.append(header);
  for (const source of sources.slice(0, 4)) {
    const row = document.createElement("p");
    const label = source.relativePath || basename(source.path);
    row.textContent = source.excerpt ? `${label}: ${compactText(source.excerpt, 110)}` : label;
    card.append(row);
  }
  message.body.append(card);
  scrollConversationToEnd();
}

function clearConversation() {
  conversationTimeline?.querySelectorAll(".message-bubble").forEach((node) => node.remove());
  state.activeTaskMessage = null;
  syncConversationState();
}

function renderRunCards(runs, activeRunId = state.lastRun?.id) {
  state.runs = Array.isArray(runs) ? runs : [];
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
      showRunDetail(run.id).catch((error) => {
        setStatus("任务记录读取失败");
        setArtifact(error.message);
      });
    });
    runList.append(card);
  }
}

async function loadRunCards(activeRunId = state.lastRun?.id) {
  if (!state.hostApi) {
    renderRunCards([], activeRunId);
    return;
  }
  const payload = await getJson("/api/runs?limit=6");
  renderRunCards(payload.runs || [], activeRunId);
}

async function refreshRunCards(activeRunId = state.lastRun?.id) {
  try {
    await loadRunCards(activeRunId);
  } catch (error) {
    if (runSummary) {
      runSummary.textContent = `运行记录暂不可用：${error.message}`;
    }
  }
}

async function showRunDetail(runId) {
  if (!state.hostApi || !runId) {
    return;
  }
  const run = await getJson(`/api/runs/${encodeURIComponent(runId)}`);

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

function replayRunEvents(message, run) {
  if (!message?.body) {
    return;
  }
  const list = document.createElement("div");
  list.className = "message-progress message-progress-sse";
  message.body.append(list);

  const appendLine = (lineState, title, meta) => {
    const row = document.createElement("div");
    row.className = `progress-line is-${lineState || "wait"}`;
    row.textContent = meta ? `${title} · ${meta}` : title;
    list.append(row);
    scrollConversationToEnd();
  };

  let rendered = 0;
  for (const event of Array.isArray(run?.events) ? run.events : []) {
    if (renderRunEventPayload(event.type, event, appendLine)) {
      rendered += 1;
    }
  }
  if (rendered === 0) {
    appendLine("wait", "这条历史任务没有可回放事件", "已打开详情");
  }
}

async function selectHistoryRun(indexRun) {
  if (!state.hostApi || !indexRun?.id) {
    return;
  }
  const run = await getJson(`/api/runs/${encodeURIComponent(indexRun.id)}`);
  renderRunCards(state.runs, run.id);
  state.lastRun = {
    id: run.id,
    path: run.runPath || indexRun.runPath || "",
    durationMs: run.durationMs || indexRun.durationMs || 0,
    failed: run.status === "failed",
  };
  if (run.recipeId) {
    state.selectedRecipeId = run.recipeId;
    state.selectedRecipeSource = "history";
    renderRecipes(state.recipes);
  }
  const prompt = run.input?.prompt || indexRun.promptPreview || "";
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

async function tryKimiCliPlan(prompt, summary) {
  if (!state.kimiCliPlanEnabled) {
    setRunChip("Kimi CLI 未启用", "muted");
    return {
      used: false,
      text: "Kimi CLI plan 未启用；当前使用本地只读摘要生成审批草稿。",
    };
  }

  try {
    setStatus("正在调用 Kimi CLI");
    const result = await postJson("/api/kimi/plan", {
      trustedRoot: state.workspace,
      prompt,
      summary,
      mode: state.view,
    });
    return {
      used: true,
      text: result.text,
      durationMs: result.durationMs,
      runId: result.runId,
      runPath: result.runPath,
    };
  } catch (error) {
    const runId = error.payload?.runId;
    setRunChip(runId ? `Kimi CLI 失败 · ${shortRunId(runId)}` : "Kimi CLI 已降级", "muted");
    return {
      used: false,
      text: `Kimi CLI 暂不可用，已降级到本地计划：${error.message}`,
      runId,
      runPath: error.payload?.runPath,
      failed: Boolean(runId),
    };
  }
}

async function tryKimiChat(prompt, summary) {
  if (!state.kimiCliPlanEnabled) {
    setRunChip("Kimi CLI 未启用", "muted");
    return {
      used: false,
      text: `Kimi CLI chat 未启用；已收到消息：“${prompt.slice(0, 80)}”。需要真实对话时请用 ENABLE_KIMI_CLI_PLAN=1 启动。`,
    };
  }

  try {
    setRunChip("Kimi CLI 对话中", "ready");
    const result = await postJson("/api/kimi/chat", {
      trustedRoot: state.workspace,
      prompt,
      summary,
    });
    return {
      used: true,
      text: result.text,
      durationMs: result.durationMs,
      runId: result.runId,
      runPath: result.runPath,
    };
  } catch (error) {
    const runId = error.payload?.runId;
    setRunChip(runId ? `Kimi CLI 失败 · ${shortRunId(runId)}` : "Kimi CLI 已降级", "muted");
    return {
      used: false,
      text: `Kimi CLI 暂不可用：${error.message}`,
      runId,
      runPath: error.payload?.runPath,
      failed: Boolean(runId),
    };
  }
}

async function sendChatMessage(prompt) {
  appendUserMessage(prompt);
  const message = appendAssistantMessage("我先读取当前可用上下文，然后直接回复。", { status: "对话 · 处理中" });
  if (!state.hostApi) {
    const fallback = `已收到：“${prompt.slice(0, 120)}”。通过 localhost 启动后可调用 Kimi。`;
    showChatResponse(fallback);
    appendMessageText(message, fallback);
    setMessageStatus(message, "对话 · 本地预览");
    return;
  }
  setStatus("正在发送给 Kimi");
  const candidate = textCandidate(activeFiles());
  const summary = await readCandidateSummary(candidate);
  addProgressLines(message, [
    {
      state: "done",
      title: candidate ? `已读取上下文：${candidate.path}` : "当前没有额外本地文件上下文",
    },
    {
      state: "running",
      title: state.kimiCliPlanEnabled ? "正在调用 Kimi CLI 对话" : "Kimi CLI 未启用，使用本地安全回复",
    },
  ]);
  const reply = await tryKimiChat(prompt, summary);
  state.lastRun = reply.runId
    ? {
        id: reply.runId,
        path: reply.runPath,
        durationMs: reply.durationMs,
        failed: reply.failed === true,
      }
    : null;
  showChatResponse(reply.text);
  appendMessageText(message, reply.text);
  if (reply.used) {
    setRunChip(`Kimi Chat · ${shortRunId(reply.runId)} · ${reply.durationMs}ms`, "ready");
    setStatus("Kimi 已回复");
    setMessageStatus(message, "对话 · 已回复");
  } else if (reply.failed) {
    setRunChip(`Kimi Chat 失败 · ${shortRunId(reply.runId)}`, "muted");
    setStatus("Kimi 已降级");
    setMessageStatus(message, "对话 · 已降级");
  } else {
    setStatus("本地回复");
    setMessageStatus(message, "对话 · 本地回复");
  }
  await refreshRunCards(reply.runId);
}

async function refreshWorkspaceTree() {
  const tree = await postJson("/api/files/tree", { root: state.workspace });
  state.files = tree.files;
  summarizeFiles(tree.files);
  renderFiles(tree.files);
}

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
  state.approved = false;
  approveButton.textContent = "审批执行";
  approveButton.classList.remove("is-done");
  renderOperations(preview.operations);
  const sourceCopy = state.lastSources.length > 0
    ? state.lastSources.map((source) => source.relativePath || basename(source.path)).join("、")
    : "无来源文件";
  const sourceExcerpt = compactText(state.lastSources.find((source) => source.excerpt)?.excerpt || "", 150);
  const firstOutput = preview.operations[0]?.path?.replace(state.workspace, ".") || ".KimiCowork/artifacts";
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

async function uploadSelectedFiles(fileList, sourceLabel) {
  const selected = Array.from(fileList || []);
  if (selected.length === 0) {
    return;
  }
  if (!state.hostApi) {
    setArtifact("静态预览模式不能上传文件；请通过 localhost 启动本地 Host。");
    return;
  }
  if (selected.length > 80) {
    setArtifact("一次最多上传 80 个文件。");
    return;
  }

  const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 12 * 1024 * 1024) {
    setArtifact("当前 MVP 一次最多导入 12MB 文件；大文件后续走本地授权目录读取。");
    return;
  }

  setView("cowork");
  setStatus("正在导入文件");
  const files = [];
  for (const file of selected) {
    files.push({
      name: file.name,
      relativePath: file.webkitRelativePath || file.name,
      size: file.size,
      type: file.type,
      contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
    });
  }

  const imported = await postJson("/api/uploads/import", {
    trustedRoot: state.workspace,
    files,
  });
  state.uploadedFiles = imported.imported.map((file) => ({
    path: file.path.replace(state.workspace, "").replace(/^[\\/]/, "").replace(/\\/g, "/"),
    fullPath: file.path,
    kind: "file",
    size: file.size,
  }));
  await refreshWorkspaceTree();
  const rootLabel = imported.uploadRoot.replace(state.workspace, ".");
  setArtifact(
    `已${sourceLabel} ${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节。现在可以直接发送任务让 Kimi 基于摘要生成计划。`,
    rootLabel,
  );
  const message = appendAssistantMessage(
    `已${sourceLabel} ${imported.imported.length} 个文件。你现在可以直接发送整理、提取、总结或生成表格任务。`,
    { status: "协作 · 文件已就绪" },
  );
  addArtifactCard(message, "已授权本地文件", `${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节`, rootLabel);
  renderInteraction(
    [
      {
        state: "done",
        title: "已导入本地文件",
        detail: `${sourceLabel} ${imported.imported.length} 个文件，合计 ${imported.totalBytes} 字节。`,
        meta: rootLabel,
      },
      {
        state: "active",
        title: "等待用户任务",
        detail: "下一次发送会优先读取刚导入的文件，并在这里展示 Kimi 的计划过程。",
      },
    ],
    "文件已就绪",
  );
  setStatus("文件已导入");
  composer.value = composer.value || `读取刚上传的 ${imported.imported.length} 个文件，生成整理计划`;
  composer.focus();
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
          detail: "通过 localhost 启动后可读取文件、调用 Kimi CLI，并写入审计日志。",
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
        detail: state.kimiCliPlanEnabled ? "正在调用本机 Kimi CLI，输出只作为计划文本，不直接执行本地操作。" : "Kimi CLI 未启用，使用本地摘要生成安全草稿。",
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
      title: state.kimiCliPlanEnabled ? "正在调用 Kimi CLI 生成计划" : "Kimi CLI 未启用，使用本地摘要生成安全草稿",
    },
  ]);
  const kimiPlan = await tryKimiCliPlan(prompt, summary);
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
  const outputPath = joinWin(state.workspace, ".KimiCowork", "artifacts", `ui-plan-${id}.md`);
  state.operations = [
    {
      type: "write",
      path: outputPath,
      content: [
        "# Kimi Cowork 界面计划",
        "",
        `- 模式: ${state.view}`,
        `- 指令: ${prompt}`,
        `- 工作区: ${state.workspace}`,
        `- 来源摘要: ${summary}`,
        `- Kimi CLI: ${kimiPlan.used ? `已接入，耗时 ${kimiPlan.durationMs}ms` : kimiPlan.failed ? "调用失败，已安全降级" : "未使用，安全降级"}`,
        `- Run ID: ${kimiPlan.runId || "local-fallback"}`,
        `- Run 记录: ${kimiPlan.runPath ? kimiPlan.runPath.replace(state.workspace, ".") : "未生成"}`,
        `- 生成时间: ${now.toISOString()}`,
        "",
        "## Kimi CLI 计划",
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
  state.approved = false;
  approveButton.textContent = "审批执行";
  approveButton.classList.remove("is-done");
  renderOperations(preview.operations);
  setArtifact(
    kimiPlan.used
      ? `已读取本地内容：${summary}；Kimi CLI 已生成计划，运行记录 ${shortRunId(kimiPlan.runId)}。`
      : `已读取本地内容：${summary}`,
    outputPath.replace(state.workspace, "."),
  );
  if (kimiPlan.used) {
    setRunChip(`Kimi CLI · ${shortRunId(kimiPlan.runId)} · ${kimiPlan.durationMs}ms`, "ready");
  } else if (kimiPlan.failed) {
    setRunChip(`Kimi CLI 失败 · ${shortRunId(kimiPlan.runId)}`, "muted");
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
    idempotencyKey: state.applyIdempotencyKey || idempotencyKey("apply"),
  });
  state.approved = true;
  approveButton.textContent = "已审批";
  approveButton.classList.add("is-done");
  setArtifact(`已在本机执行 ${applied.applied.length} 个审批操作，并写入审计日志。`);
  const artifactPathText = applied.applied[0]?.path?.replace?.(state.workspace, ".") || artifactPath.textContent || ".KimiCowork/artifacts";
  addProgressLines(state.activeTaskMessage, [
    {
      state: "done",
      title: `执行完成：已应用 ${applied.applied.length} 个操作`,
      meta: ".KimiCowork/audit/host-events.jsonl",
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
        meta: ".KimiCowork/audit/host-events.jsonl",
      },
    ],
    "执行完成",
  );
  setStatus("已在本机执行");
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
    state.kimiCliPlanEnabled = workspace.kimiCli?.planEnabled === true || workspace.kimiCli?.chatEnabled === true;
    setRunChip(state.kimiCliPlanEnabled ? "Kimi CLI 计划已启用" : "Kimi CLI 未启用", state.kimiCliPlanEnabled ? "ready" : "muted");
    workspacePath.textContent = state.workspace;

    await refreshWorkspaceTree();
    await loadRecipes();
    await refreshRunCards();
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

setView("chat");
resetInteraction();
renderRunCards([]);
loadHostWorkspace();
