const state = {
  view: "chat",
  workspace: "C:\\Users\\Administrator\\Desktop\\kimi cowork",
  files: [],
  operations: [],
  approved: false,
  hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
  kimiCliPlanEnabled: false,
  lastRun: null,
  uploadedFiles: [],
  interactionItems: [],
};

window.kimiCowork = state;

const composer = document.querySelector(".composer textarea");
const uploadInput = document.querySelector(".upload-input");
const folderInput = document.querySelector(".folder-input");
const approveButton = document.querySelector(".approve-button");
const sendButton = document.querySelector(".send-button");
const artifactText = document.querySelector(".artifact-preview p");
const artifactPath = document.querySelector(".artifact-preview code");
const statusText = document.querySelector(".status-text");
const runChip = document.querySelector(".run-chip");
const workspacePath = document.querySelector(".workspace-card > strong");
const workspaceMeta = document.querySelector(".workspace-card > p");
const fileList = document.querySelector(".file-list");
const operationList = document.querySelector(".operation-list");
const chatOutput = document.querySelector(".chat-output");
const chatOutputText = document.querySelector(".chat-output p");
const workbenchTitle = document.querySelector(".workbench-title");
const workbenchCopy = document.querySelector(".workbench-copy");
const interactionSubtitle = document.querySelector(".interaction-subtitle");
const interactionItems = document.querySelector(".interaction-items");

const placeholders = {
  chat: "今天想让 Kimi 做什么？",
  cowork: "选择本地文件夹，描述要让 Kimi Cowork 在本机完成的操作",
  code: "描述要让 Kimi 在本地检查的代码任务",
  projects: "搜索或打开一个项目",
  artifacts: "查找产物或审计日志",
  customize: "告诉 Kimi 这个工作区应该如何运行",
};

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

function compactText(text, maxLength = 220) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function basename(filePath) {
  return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function joinWin(root, ...parts) {
  return [root.replace(/[\\/]+$/, ""), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ""))].join("\\");
}

function uniqueStamp(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${timestamp}-${suffix}`;
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

async function postJson(route, body) {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || `${route} returned ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function textCandidate(files) {
  return files.find((file) => /\.(md|txt|csv)$/i.test(file.path)) || files.find((file) => file.kind === "file");
}

function activeFiles() {
  return [...state.uploadedFiles, ...state.files];
}

async function readCandidateSummary(candidate) {
  if (!candidate) {
    return "当前工作区没有可读取的文本文件，先生成一个本地审批产物。";
  }
  try {
    const read = await postJson("/api/files/read", {
      trustedRoot: state.workspace,
      path: candidate.fullPath,
      maxSize: 1600,
    });
    return read.content.replace(/\s+/g, " ").slice(0, 180);
  } catch (error) {
    return `文件 ${candidate.path} 暂不可直接读取：${error.message}`;
  }
}

function showChatResponse(message) {
  chatOutput.hidden = false;
  chatOutputText.textContent = message;
}

function shortRunId(runId) {
  return String(runId || "").split("_").slice(-1)[0] || runId;
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
  if (!state.hostApi) {
    showChatResponse(`已收到：“${prompt.slice(0, 120)}”。通过 localhost 启动后可调用 Kimi。`);
    return;
  }
  setStatus("正在发送给 Kimi");
  const candidate = textCandidate(activeFiles());
  const summary = await readCandidateSummary(candidate);
  const reply = await tryKimiChat(prompt, summary);
  showChatResponse(reply.text);
  if (reply.used) {
    setRunChip(`Kimi Chat · ${shortRunId(reply.runId)} · ${reply.durationMs}ms`, "ready");
    setStatus("Kimi 已回复");
  } else if (reply.failed) {
    setRunChip(`Kimi Chat 失败 · ${shortRunId(reply.runId)}`, "muted");
    setStatus("Kimi 已降级");
  } else {
    setStatus("本地回复");
  }
}

async function refreshWorkspaceTree() {
  const tree = await postJson("/api/files/tree", { root: state.workspace });
  state.files = tree.files;
  summarizeFiles(tree.files);
  renderFiles(tree.files);
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

async function generatePlan() {
  const prompt = composer.value.trim() || "整理这个本地文件夹，生成可审批的安全操作计划";

  if (state.view !== "cowork" && state.view !== "code") {
    chatOutput.hidden = true;
    setView("cowork");
  }
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
  });
  state.approved = true;
  approveButton.textContent = "已审批";
  approveButton.classList.add("is-done");
  setArtifact(`已在本机执行 ${applied.applied.length} 个审批操作，并写入审计日志。`);
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

async function loadHostWorkspace() {
  if (!state.hostApi) {
    setStatus("静态预览");
    return;
  }

  try {
    const workspace = await (await fetch("/api/workspace")).json();
    state.workspace = workspace.trustedRoot;
    state.kimiCliPlanEnabled = workspace.kimiCli?.planEnabled === true || workspace.kimiCli?.chatEnabled === true;
    setRunChip(state.kimiCliPlanEnabled ? "Kimi CLI 计划已启用" : "Kimi CLI 未启用", state.kimiCliPlanEnabled ? "ready" : "muted");
    workspacePath.textContent = state.workspace;

    await refreshWorkspaceTree();
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

document.querySelector('[data-action="upload-files"]').addEventListener("click", () => {
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

document.querySelector('[data-action="new-chat"]').addEventListener("click", () => {
  setView("chat");
  composer.value = "";
  chatOutput.hidden = true;
  state.operations = [];
  state.approved = false;
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
  generatePlan().catch((error) => {
    setStatus("计划失败");
    setArtifact(error.message);
  });
});

approveButton.addEventListener("click", () => {
  approvePlan().catch((error) => {
    setStatus("执行受阻");
    setArtifact(error.message);
  });
});

setView("chat");
resetInteraction();
loadHostWorkspace();
