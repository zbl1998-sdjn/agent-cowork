// 在线 MVP 实例浏览器端到端冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:读取 build/mvp-runtime.json 找到正在运行的 MVP 实例(校验 pid 存活、
//       /health 正常),用 headless Edge/Chrome 经 CDP 打开运行 URL,完成访客
//       登录 → 校验工作区/导航/起始动作 → 发送指令触发计划预览 → 审批执行,
//       断言时间线、产物卡片、磁盘上新写入的 Markdown 产物及审计日志增长,
//       截图并写 build/live-mvp-smoke-report.json(失败时 ok=false 并退 1)。
// 用法:npm run smoke:live-mvp(经 run-host-node.mjs 跑本 .ts);
//       须先 npm run start:mvp 让 MVP 实例在运行,且本机有 Edge/Chrome。
// 依赖:./browser-smoke-utils 的 CDP 工具;build/mvp-runtime.json;本地浏览器。
import { spawn } from 'node:child_process';
import type { ChildProcessLike } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CdpClient,
  assert,
  errorDetails,
  evaluate,
  findBrowser,
  getFreePort,
  getJson,
  isRecord,
  type CdpSession,
  type CdpTarget,
  type CdpVersion,
  type ScreenshotResult,
  type SendPage,
} from './browser-smoke-utils.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const runtimeFile = path.join(buildDir, 'mvp-runtime.json');
const reportPath = path.join(buildDir, 'live-mvp-smoke-report.json');
const screenshotPath = path.join(buildDir, 'live-mvp-smoke-1536x900.png');

type MvpRuntime = {
  pid: number;
  host: string;
  port: number;
  url: string;
  workspace: string;
  auditPath?: string | undefined;
  kimiApiPlanEnabled?: boolean | undefined;
};

type HealthSnapshot = {
  ok?: boolean;
  service?: string;
};

type AuthSnapshot = {
  usedGuest: boolean;
  alreadyAuthed?: boolean | undefined;
  user?: string | undefined;
};

type ScrollMetrics = {
  width: number;
  clientWidth: number;
  height: number;
  clientHeight: number;
};

type DesktopLayout = {
  title: string;
  location: string;
  workspace: string;
  user: string;
  hasShell: boolean;
  hasTimeline: boolean;
  hasComposer: boolean;
  hasEmptyState: boolean;
  hasCowork: boolean;
  hasConversationRail: boolean;
  hasHeaderActions: boolean;
  hasQuickActions: boolean;
  starterCount: number;
  starterText: string;
  scroll: ScrollMetrics;
};

type LiveInteraction = {
  afterPlan: {
    preview: string;
    opCount: number;
    timeline: string;
    bubbleCount: number;
    approveText: string;
  };
  afterApprove: {
    approval: string;
    timeline: string;
    artifactCards: number;
  };
};

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert(typeof value === 'string' && value.length > 0, `runtime field ${key} must be a non-empty string`);
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  assert(typeof value === 'number' && Number.isFinite(value), `field ${key} must be a finite number`);
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  assert(typeof value === 'boolean', `field ${key} must be a boolean`);
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalBooleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert(isRecord(value), `field ${key} must be an object`);
  return value;
}

function readRuntime(): MvpRuntime {
  assert(fs.existsSync(runtimeFile), `MVP runtime file is missing: ${runtimeFile}. Start the product with npm run start:mvp first.`);
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as unknown;
  assert(isRecord(runtime), 'MVP runtime file must contain an object');
  const pid = numberField(runtime, 'pid');
  assert(isPidAlive(pid), `MVP runtime pid is not alive: ${pid}`);
  return {
    pid,
    host: stringField(runtime, 'host'),
    port: numberField(runtime, 'port'),
    url: stringField(runtime, 'url'),
    workspace: stringField(runtime, 'workspace'),
    auditPath: optionalStringField(runtime, 'auditPath'),
    kimiApiPlanEnabled: optionalBooleanField(runtime, 'kimiApiPlanEnabled'),
  };
}

function readAuthSnapshot(value: unknown): AuthSnapshot {
  assert(isRecord(value), 'auth snapshot must be an object');
  return {
    usedGuest: booleanField(value, 'usedGuest'),
    alreadyAuthed: optionalBooleanField(value, 'alreadyAuthed'),
    user: optionalStringField(value, 'user'),
  };
}

function readScrollMetrics(value: unknown): ScrollMetrics {
  assert(isRecord(value), 'scroll metrics must be an object');
  return {
    width: numberField(value, 'width'),
    clientWidth: numberField(value, 'clientWidth'),
    height: numberField(value, 'height'),
    clientHeight: numberField(value, 'clientHeight'),
  };
}

function readDesktopLayout(value: unknown): DesktopLayout {
  assert(isRecord(value), 'desktop layout snapshot must be an object');
  return {
    title: stringField(value, 'title'),
    location: stringField(value, 'location'),
    workspace: stringField(value, 'workspace'),
    user: stringField(value, 'user'),
    hasShell: booleanField(value, 'hasShell'),
    hasTimeline: booleanField(value, 'hasTimeline'),
    hasComposer: booleanField(value, 'hasComposer'),
    hasEmptyState: booleanField(value, 'hasEmptyState'),
    hasCowork: booleanField(value, 'hasCowork'),
    hasConversationRail: booleanField(value, 'hasConversationRail'),
    hasHeaderActions: booleanField(value, 'hasHeaderActions'),
    hasQuickActions: booleanField(value, 'hasQuickActions'),
    starterCount: numberField(value, 'starterCount'),
    starterText: stringField(value, 'starterText'),
    scroll: readScrollMetrics(value.scroll),
  };
}

function readInteraction(value: unknown): LiveInteraction {
  assert(isRecord(value), 'interaction snapshot must be an object');
  const afterPlan = recordField(value, 'afterPlan');
  const afterApprove = recordField(value, 'afterApprove');
  return {
    afterPlan: {
      preview: stringField(afterPlan, 'preview'),
      opCount: numberField(afterPlan, 'opCount'),
      timeline: stringField(afterPlan, 'timeline'),
      bubbleCount: numberField(afterPlan, 'bubbleCount'),
      approveText: stringField(afterPlan, 'approveText'),
    },
    afterApprove: {
      approval: stringField(afterApprove, 'approval'),
      timeline: stringField(afterApprove, 'timeline'),
      artifactCards: numberField(afterApprove, 'artifactCards'),
    },
  };
}

function normalizePathText(value: string): string {
  return value.trim().replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function sameDisplayedPath(actual: string, expected: string): boolean {
  return normalizePathText(actual) === normalizePathText(expected);
}

function listArtifacts(workspace: string): string[] {
  const artifactsDir = path.join(workspace, '.AgentCowork', 'artifacts');
  if (!fs.existsSync(artifactsDir)) {
    return [];
  }
  return fs
    .readdirSync(artifactsDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(artifactsDir, name));
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const runtime = readRuntime();
  const health = await getJson<HealthSnapshot>(`http://${runtime.host}:${runtime.port}/health`, 5000);
  assert(health.ok === true && health.service === 'agent-cowork-host', 'live MVP health check failed');

  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for live MVP smoke');

  const artifactBefore = new Set(listArtifacts(runtime.workspace));
  const auditPath = runtime.auditPath || path.join(runtime.workspace, '.AgentCowork', 'audit', 'host-events.jsonl');
  const auditSizeBefore = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;

  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-live-mvp-profile-'));
  const browser: ChildProcessLike = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  const stderr: string[] = [];
  browser.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  let client: CdpClient | undefined;
  let desktopLayout: DesktopLayout | null = null;
  try {
    const version = await getJson<CdpVersion>(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send<CdpTarget>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<CdpSession>('Target.attachToTarget', { targetId, flatten: true });
    const sendPage: SendPage = (method, params = {}) => {
      assert(client, 'CDP client is not initialized');
      return client.send(method, params, sessionId);
    };

    await sendPage('Page.enable');
    await sendPage('Runtime.enable');
    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sendPage('Page.navigate', { url: runtime.url });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const shell = document.querySelector(".app-shell");
          const guest = document.querySelector(".auth-guest");
          if (document.readyState === "complete" && (shell || guest)) resolve({ shell: Boolean(shell), authGate: Boolean(guest) });
          else if (Date.now() > deadline) reject(new Error("live MVP page did not render"));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );
    const auth = readAuthSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const guest = document.querySelector(".auth-guest");
        if (!guest) {
          resolve({ usedGuest: false, alreadyAuthed: Boolean(document.querySelector(".app-shell")) });
          return;
        }
        guest.click();
        const deadline = Date.now() + 8000;
        function tick() {
          const shell = document.querySelector(".app-shell");
          const token = localStorage.getItem("kcw.authToken");
          const user = document.querySelector(".header-user")?.innerText.trim();
          if (shell && token && user) resolve({ usedGuest: true, user });
          else if (Date.now() > deadline) reject(new Error("live MVP guest login did not reach shell"));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ));
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const expectedWorkspace = ${JSON.stringify(runtime.workspace)};
        function workspaceValue() {
          const chip = document.querySelector(".workspace-chip");
          const title = chip?.getAttribute("title") || "";
          const prefix = "当前工作区:";
          if (title.startsWith(prefix)) return title.slice(prefix.length).split("\\n")[0].trim();
          return chip?.innerText.replace(/^\\S+\\s*/, "").replace(/▾$/, "").trim() || "";
        }
        function samePath(actual, expected) {
          return String(actual || "").trim().replace(/\\//g, "\\\\").replace(/\\\\+$/g, "").toLowerCase()
            === String(expected || "").trim().replace(/\\//g, "\\\\").replace(/\\\\+$/g, "").toLowerCase();
        }
        const deadline = Date.now() + 8000;
        function tick() {
          const workspace = workspaceValue();
          const ready = Boolean(document.querySelector(".timeline") && document.querySelector(".composer textarea"));
          if (ready && samePath(workspace, expectedWorkspace)) resolve(true);
          else if (Date.now() > deadline) reject(new Error("live MVP workspace did not synchronize with runtime: " + JSON.stringify({ workspace, expectedWorkspace })));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function token() { return localStorage.getItem("kcw.authToken"); }
        function tick() {
          const bearer = token();
          if (!bearer) {
            if (Date.now() > deadline) reject(new Error("live MVP auth token missing"));
            else setTimeout(tick, 50);
            return;
          }
          fetch("/api/recipes", { headers: { authorization: "Bearer " + bearer } })
            .then((response) => response.ok ? response.json() : Promise.reject(new Error("recipes returned " + response.status)))
            .then((body) => {
              if (Array.isArray(body.recipes) && body.recipes.length > 0) resolve(body.recipes.length);
              else if (Date.now() > deadline) reject(new Error("live MVP recipes did not load"));
              else setTimeout(tick, 100);
            })
            .catch((error) => {
              if (Date.now() > deadline) reject(error);
              else setTimeout(tick, 100);
            });
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const starterChips = [...document.querySelectorAll(".starter-chip")]
            .map((chip) => chip.innerText.trim())
            .filter(Boolean);
          return {
            emptyState: Boolean(document.querySelector(".empty-state")),
            starterCount: starterChips.length,
            starterText: starterChips.join("|")
          };
        }
        function tick() {
          const current = snapshot();
          if (!current.emptyState || current.starterCount >= 4) resolve(current);
          else if (Date.now() > deadline) reject(new Error("live MVP starter actions did not render: " + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    desktopLayout = readDesktopLayout(await evaluate(
      sendPage,
      `(() => {
        function workspaceValue() {
          const chip = document.querySelector(".workspace-chip");
          const title = chip?.getAttribute("title") || "";
          const prefix = "当前工作区:";
          if (title.startsWith(prefix)) return title.slice(prefix.length).split("\\n")[0].trim();
          return chip?.innerText.replace(/^\\S+\\s*/, "").replace(/▾$/, "").trim() || "";
        }
        const scroll = {
          width: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight
        };
        const text = document.body.innerText;
        const buttons = [...document.querySelectorAll("button")].map((button) => button.innerText.trim()).filter(Boolean);
        const starterChips = [...document.querySelectorAll(".starter-chip")]
          .map((chip) => chip.innerText.trim())
          .filter(Boolean);
        return {
          title: document.title,
          location: window.location.href,
          workspace: workspaceValue(),
          user: document.querySelector(".header-user")?.innerText.trim(),
          hasShell: Boolean(document.querySelector(".app-shell")),
          hasTimeline: Boolean(document.querySelector(".timeline")),
          hasComposer: Boolean(document.querySelector(".composer textarea")),
          hasEmptyState: Boolean(document.querySelector(".empty-state")),
          hasCowork: text.includes("Agent Cowork"),
          hasConversationRail: Boolean(document.querySelector(".conversation-rail")),
          hasHeaderActions: ["工具", "可视化", "连接器", "产物", "定时任务", "记忆"].every((label) => buttons.includes(label)),
          hasQuickActions: starterChips.length >= 4,
          starterCount: starterChips.length,
          starterText: starterChips.join("|"),
          scroll
        };
      })()`,
    ));
    assert(desktopLayout.title === 'Agent Cowork', 'live MVP title mismatch');
    assert(desktopLayout.location.startsWith(runtime.url), 'live MVP did not load runtime URL');
    assert(sameDisplayedPath(desktopLayout.workspace, runtime.workspace), 'live MVP workspace does not match runtime workspace');
    assert(desktopLayout.hasShell && desktopLayout.hasTimeline && desktopLayout.hasComposer, 'live MVP missing React functional shell');
    assert(desktopLayout.hasConversationRail && desktopLayout.hasHeaderActions, 'live MVP missing navigation/actions');
    assert(desktopLayout.hasCowork, 'live MVP missing product identity text');
    assert(!desktopLayout.hasEmptyState || desktopLayout.hasQuickActions, 'empty live MVP missing starter actions');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'live MVP desktop layout has horizontal overflow');

    const screenshot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const planTimeoutMs = runtime.kimiApiPlanEnabled ? 90_000 : 5000;
    const interaction = readInteraction(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const textarea = document.querySelector(".composer textarea");
        const send = document.querySelector(".send-button");
        if (!textarea || !send) reject(new Error("required controls missing"));
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        setValue.call(textarea, "live smoke: 读取当前运行工作区并生成可审批产物");
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: textarea.value }));
        send.click();

        const waitFor = (predicate, timeoutMs) => new Promise((ok, fail) => {
          const deadline = Date.now() + timeoutMs;
          function tick() {
            try {
              if (predicate()) ok(true);
              else if (Date.now() > deadline) fail(new Error("timed out"));
              else setTimeout(tick, 50);
            } catch (error) {
              fail(error);
            }
          }
          tick();
        });

        waitFor(() => document.querySelectorAll(".preview-op").length > 0 && [...document.querySelectorAll("button")].some((button) => button.innerText.trim() === "审批执行"), ${planTimeoutMs})
          .then(() => {
            const approve = [...document.querySelectorAll("button")].find((button) => button.innerText.trim() === "审批执行");
            const afterPlan = {
              preview: document.querySelector(".preview-card")?.innerText || "",
              opCount: document.querySelectorAll(".preview-op").length,
              timeline: document.querySelector(".timeline")?.innerText || "",
              bubbleCount: document.querySelectorAll(".bubble").length,
              approveText: approve?.innerText.trim() || ""
            };
            approve.click();
            return waitFor(() => document.querySelector(".approval-done")?.innerText.includes("已审批"), 5000)
              .then(() => ({
                afterPlan,
                afterApprove: {
                  approval: document.querySelector(".approval-done")?.innerText.trim(),
                  timeline: document.querySelector(".timeline")?.innerText || "",
                  artifactCards: document.querySelectorAll(".artifact-card").length
                }
              }));
          })
          .then(resolve, reject);
      })`,
    ));
    assert(interaction.afterPlan.opCount >= 1, 'live MVP did not render any operation preview');
    assert(interaction.afterPlan.preview.includes('操作预览'), 'live MVP preview card missing');
    assert(interaction.afterPlan.approveText === '审批执行', 'live MVP approval button missing');
    assert(interaction.afterApprove.approval.includes('已审批'), 'live MVP approve did not reach approved state');
    assert(interaction.afterApprove.artifactCards >= 1, 'live MVP did not show artifact card after approval');

    const artifactAfter = listArtifacts(runtime.workspace);
    const newArtifacts = artifactAfter.filter((artifactPath) => !artifactBefore.has(artifactPath));
    assert(newArtifacts.length > 0, 'live MVP did not write a new artifact');
    const markdownArtifact = newArtifacts.find((artifactPath) => artifactPath.toLowerCase().endsWith('.md'));
    assert(markdownArtifact, 'live MVP did not write a Markdown artifact');
    const artifactContent = fs.readFileSync(markdownArtifact, 'utf8');
    assert(artifactContent.includes('会议纪要行动项') && artifactContent.includes('live smoke'), 'live MVP Markdown artifact missing expected content');
    assert(fs.existsSync(auditPath), 'live MVP audit log missing');
    const auditSizeAfter = fs.statSync(auditPath).size;
    assert(auditSizeAfter > auditSizeBefore, 'live MVP audit log did not grow after approval');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      runtime,
      health,
      browserPath,
      screenshotPath,
      auth,
      desktopLayout,
      interaction,
      artifacts: newArtifacts,
      auditPath,
      auditSizeBefore,
      auditSizeAfter,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      runtime,
      browserPath,
      desktopLayout,
      error: errorDetails(error),
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(errorDetails(error));
    process.exitCode = 1;
  } finally {
    client?.close();
    browser.kill();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

main().catch((error) => {
  console.error(errorDetails(error));
  process.exit(1);
});
