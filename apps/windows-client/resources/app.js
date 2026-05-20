const state = {
  mode: "office",
  workspace: "C:\\Users\\Administrator\\Desktop\\kimi cowork",
  files: [],
  operations: [],
  approved: false,
  hostApi: window.location.protocol === "http:" || window.location.protocol === "https:",
};

window.kimiCowork = state;

const composer = document.querySelector(".composer textarea");
const approveButton = document.querySelector(".approve-button");
const sendButton = document.querySelector(".send-button");
const artifactText = document.querySelector(".artifact-preview p");
const artifactPath = document.querySelector(".artifact-preview code");
const statusPill = document.querySelector(".status-pill");
const workspacePath = document.querySelector(".workspace-card > strong");
const workspaceMeta = document.querySelector(".workspace-card > p");
const fileList = document.querySelector(".file-list");
const operationList = document.querySelector(".operation-list");

function setStatus(text) {
  statusPill.childNodes[statusPill.childNodes.length - 1].textContent = ` ${text}`;
}

function setArtifact(message, pathText = artifactPath.textContent) {
  artifactText.textContent = message;
  artifactPath.textContent = pathText;
}

function basename(filePath) {
  return String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || filePath;
}

function joinWin(root, ...parts) {
  return [root.replace(/[\\/]+$/, ""), ...parts.map((part) => String(part).replace(/^[\\/]+|[\\/]+$/g, ""))].join("\\");
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
    throw new Error(payload.error || `${route} returned ${response.status}`);
  }
  return payload;
}

function textCandidate(files) {
  return files.find((file) => /\.(md|txt|csv)$/i.test(file.path)) || files.find((file) => file.kind === "file");
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

async function generatePlan() {
  const prompt = composer.value.trim() || "整理这个本地文件夹，生成可审批的安全操作计划";

  if (!state.hostApi) {
    setStatus("Preview Mode");
    setArtifact(`已根据 “${prompt.slice(0, 42)}” 生成本地操作预览，等待审批。`);
    return;
  }

  setStatus("Reading Workspace");
  const candidate = textCandidate(state.files);
  const summary = await readCandidateSummary(candidate);
  const now = new Date();
  const id = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const outputPath = joinWin(state.workspace, ".KimiCowork", "artifacts", `ui-plan-${id}.md`);
  state.operations = [
    {
      type: "write",
      path: outputPath,
      content: [
        "# Kimi Cowork UI Plan",
        "",
        `- Prompt: ${prompt}`,
        `- Workspace: ${state.workspace}`,
        `- Source summary: ${summary}`,
        `- Generated at: ${now.toISOString()}`,
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
  setArtifact(`已读取本地内容：${summary}`, outputPath.replace(state.workspace, "."));
  setStatus("Plan Ready");
}

async function approvePlan() {
  if (!state.hostApi) {
    state.approved = true;
    approveButton.textContent = "已审批";
    approveButton.classList.add("is-done");
    setArtifact("预览模式下已完成界面状态切换；通过 localhost 启动可执行真实本地写入。");
    setStatus("Preview Applied");
    return;
  }

  if (state.approved) {
    return;
  }
  if (state.operations.length === 0) {
    await generatePlan();
  }

  setStatus("Applying Locally");
  const applied = await postJson("/api/file-ops/apply", {
    trustedRoot: state.workspace,
    operations: state.operations,
  });
  state.approved = true;
  approveButton.textContent = "已审批";
  approveButton.classList.add("is-done");
  setArtifact(`已在本机执行 ${applied.applied.length} 个审批操作，并写入审计日志。`);
  setStatus("Applied Locally");
}

async function loadHostWorkspace() {
  if (!state.hostApi) {
    setStatus("Static Preview");
    return;
  }

  try {
    const workspace = await (await fetch("/api/workspace")).json();
    state.workspace = workspace.trustedRoot;
    workspacePath.textContent = state.workspace;

    const tree = await postJson("/api/files/tree", { root: state.workspace });
    state.files = tree.files;
    summarizeFiles(tree.files);
    renderFiles(tree.files);
    setStatus("Local Agent Ready");
  } catch (error) {
    setStatus("Host API Offline");
    setArtifact(`无法连接本地 Host API：${error.message}`);
  }
}

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((entry) => entry.classList.remove("is-active"));
    item.classList.add("is-active");
  });
});

sendButton.addEventListener("click", () => {
  generatePlan().catch((error) => {
    setStatus("Plan Failed");
    setArtifact(error.message);
  });
});

approveButton.addEventListener("click", () => {
  approvePlan().catch((error) => {
    setStatus("Apply Blocked");
    setArtifact(error.message);
  });
});

loadHostWorkspace();
