import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';
import {
  CdpClient,
  assert,
  bind,
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
import type { ChildProcessLike } from 'node:child_process';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'rendered-ui-smoke-report.json');
const screenshotPath = path.join(buildDir, 'rendered-ui-smoke-1536x900.png');

type ScrollMetrics = {
  width: number;
  clientWidth: number;
  height: number;
  clientHeight: number;
};

type DesktopLayout = {
  title: string;
  status: string;
  activeMode: string;
  hasGreeting: boolean;
  hasCowork: boolean;
  hasModeTabs: boolean;
  hasSidebarActions: boolean;
  hasQuickActions: boolean;
  hasInteractionStream: boolean;
  hasRunCards: boolean;
  hasFrameworkOverlay: boolean;
  scroll: ScrollMetrics;
};

type CompactLayout = {
  viewport: { width: number; height: number };
  issues: string[];
  scroll: ScrollMetrics;
};

type RenderedInteraction = {
  afterPlan: {
    status: string;
    artifact: string;
    opCount: number;
    stream: string;
    runCardCount: number;
    activeRunCard: string;
    runSummary: string;
  };
  afterApprove: {
    status: string;
    artifact: string;
    approve: string;
    doneClass: boolean;
    stream: string;
  };
};

type UploadAndChat = {
  uploadState: {
    status: string;
    artifact: string;
    files: string[];
  };
  taskState: {
    activeMode: string;
    status: string;
    artifact: string;
    chatHidden: boolean;
    stream: string;
    runCardCount: number;
    activeRunCard: string;
  };
};

function readScrollMetrics(value: unknown, label: string): ScrollMetrics {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    width: typeof value.width === 'number' ? value.width : 0,
    clientWidth: typeof value.clientWidth === 'number' ? value.clientWidth : 0,
    height: typeof value.height === 'number' ? value.height : 0,
    clientHeight: typeof value.clientHeight === 'number' ? value.clientHeight : 0,
  };
}

function readDesktopLayout(value: unknown): DesktopLayout {
  if (!isRecord(value)) throw new TypeError('desktop layout snapshot must be an object');
  return {
    title: typeof value.title === 'string' ? value.title : '',
    status: typeof value.status === 'string' ? value.status : '',
    activeMode: typeof value.activeMode === 'string' ? value.activeMode : '',
    hasGreeting: value.hasGreeting === true,
    hasCowork: value.hasCowork === true,
    hasModeTabs: value.hasModeTabs === true,
    hasSidebarActions: value.hasSidebarActions === true,
    hasQuickActions: value.hasQuickActions === true,
    hasInteractionStream: value.hasInteractionStream === true,
    hasRunCards: value.hasRunCards === true,
    hasFrameworkOverlay: value.hasFrameworkOverlay === true,
    scroll: readScrollMetrics(value.scroll, 'desktop scroll metrics'),
  };
}

function readCompactLayout(value: unknown): CompactLayout {
  if (!isRecord(value)) throw new TypeError('compact layout snapshot must be an object');
  const viewport = isRecord(value.viewport) ? value.viewport : {};
  return {
    viewport: {
      width: typeof viewport.width === 'number' ? viewport.width : 0,
      height: typeof viewport.height === 'number' ? viewport.height : 0,
    },
    issues: Array.isArray(value.issues) ? value.issues.filter((issue): issue is string => typeof issue === 'string') : [],
    scroll: readScrollMetrics(value.scroll, 'compact scroll metrics'),
  };
}

function readRenderedInteraction(value: unknown): RenderedInteraction {
  if (!isRecord(value)) throw new TypeError('rendered interaction snapshot must be an object');
  const afterPlan = isRecord(value.afterPlan) ? value.afterPlan : {};
  const afterApprove = isRecord(value.afterApprove) ? value.afterApprove : {};
  return {
    afterPlan: {
      status: typeof afterPlan.status === 'string' ? afterPlan.status : '',
      artifact: typeof afterPlan.artifact === 'string' ? afterPlan.artifact : '',
      opCount: typeof afterPlan.opCount === 'number' ? afterPlan.opCount : 0,
      stream: typeof afterPlan.stream === 'string' ? afterPlan.stream : '',
      runCardCount: typeof afterPlan.runCardCount === 'number' ? afterPlan.runCardCount : 0,
      activeRunCard: typeof afterPlan.activeRunCard === 'string' ? afterPlan.activeRunCard : '',
      runSummary: typeof afterPlan.runSummary === 'string' ? afterPlan.runSummary : '',
    },
    afterApprove: {
      status: typeof afterApprove.status === 'string' ? afterApprove.status : '',
      artifact: typeof afterApprove.artifact === 'string' ? afterApprove.artifact : '',
      approve: typeof afterApprove.approve === 'string' ? afterApprove.approve : '',
      doneClass: afterApprove.doneClass === true,
      stream: typeof afterApprove.stream === 'string' ? afterApprove.stream : '',
    },
  };
}

function readUploadAndChat(value: unknown): UploadAndChat {
  if (!isRecord(value)) throw new TypeError('upload and chat snapshot must be an object');
  const uploadState = isRecord(value.uploadState) ? value.uploadState : {};
  const taskState = isRecord(value.taskState) ? value.taskState : {};
  return {
    uploadState: {
      status: typeof uploadState.status === 'string' ? uploadState.status : '',
      artifact: typeof uploadState.artifact === 'string' ? uploadState.artifact : '',
      files: Array.isArray(uploadState.files)
        ? uploadState.files.filter((file): file is string => typeof file === 'string')
        : [],
    },
    taskState: {
      activeMode: typeof taskState.activeMode === 'string' ? taskState.activeMode : '',
      status: typeof taskState.status === 'string' ? taskState.status : '',
      artifact: typeof taskState.artifact === 'string' ? taskState.artifact : '',
      chatHidden: taskState.chatHidden === true,
      stream: typeof taskState.stream === 'string' ? taskState.stream : '',
      runCardCount: typeof taskState.runCardCount === 'number' ? taskState.runCardCount : 0,
      activeRunCard: typeof taskState.activeRunCard === 'string' ? taskState.activeRunCard : '',
    },
  };
}

function listFilesRecursive(root: string, predicate: (name: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesRecursive(full, predicate));
    } else if (entry.isFile() && predicate(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for rendered UI smoke');

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-rendered-ui-'));
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'finance'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'contracts', 'sample-contract.txt'),
    'Contract draft. Party A, Party B, renewal date, payment terms.',
    'utf8',
  );
  fs.writeFileSync(path.join(workspace, 'finance', 'invoices.csv'), 'vendor,amount\nMoonshot,1280\nOffice,360\n', 'utf8');
  fs.writeFileSync(path.join(workspace, 'meeting-notes.md'), '# Weekly\n- Prepare summary\n', 'utf8');

  const auditPath = path.join(workspace, '.AgentCowork', 'audit', 'rendered-ui.jsonl');
  const host = createServer({
    trustedRoot: workspace,
    journalWriter: new JsonlWriter(auditPath),
    requireAuth: false,
    uiDist: false,
    kimiPlanRunner: async (options = {}) => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-test',
      mode: 'plan',
      text: `测试 Kimi 计划：${options.mode} / ${options.prompt} / ${options.summary}`,
      durationMs: 16,
    }),
    kimiChatRunner: async (options = {}) => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-test',
      mode: 'chat',
      text: `测试 Kimi 对话：${options.prompt} / ${options.summary}`,
      durationMs: 12,
    }),
  });
  const baseUrl = await bind(host);
  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-chrome-profile-'));
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
  browser.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
  });

  let client: CdpClient | undefined;
  try {
    const version = await getJson<CdpVersion>(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send<CdpTarget>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<CdpSession>('Target.attachToTarget', { targetId, flatten: true });
    const sendPage: SendPage = (method, params = {}) => {
      assert(client, 'DevTools client is not open');
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

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function tick() {
          if (document.readyState === "complete" && document.body.innerText.includes("欢迎回来，Derrick")) resolve(true);
          else if (Date.now() > deadline) reject(new Error("page did not render"));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function tick() {
          const status = document.querySelector(".status-pill")?.innerText.trim();
          if (status === "本地 Agent 就绪") resolve(true);
          else if (Date.now() > deadline) reject(new Error("workspace did not become ready"));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const desktopLayout = readDesktopLayout(await evaluate(
      sendPage,
      `(() => {
        const scroll = {
          width: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight
        };
        const text = document.body.innerText;
        return {
          title: document.title,
          status: document.querySelector(".status-pill")?.innerText.trim(),
          activeMode: document.querySelector(".mode-tab.is-active")?.innerText.trim(),
          hasGreeting: text.includes("欢迎回来，Derrick"),
          hasCowork: text.includes("Agent Cowork"),
          hasModeTabs: text.includes("对话") && text.includes("协作") && text.includes("代码"),
          hasSidebarActions: text.includes("新建会话") && text.includes("项目") && text.includes("产物") && text.includes("自定义"),
          hasQuickActions: text.includes("代码") && text.includes("学习") && text.includes("写作") && text.includes("Kimi 推荐") && text.includes("上传文件夹"),
          hasInteractionStream: document.querySelector(".interaction-stream")?.textContent.includes("执行动态") === true,
          hasRunCards: document.querySelector(".run-history-panel")?.textContent.includes("任务卡片") === true,
          hasFrameworkOverlay: /vite|webpack|next\\\\.js|runtime error/i.test(text),
          scroll
        };
      })()`,
    ));
    assert(desktopLayout.title === 'Agent Cowork', 'rendered page title mismatch');
    assert(desktopLayout.activeMode === '对话', 'rendered page should default to 对话 mode');
    assert(desktopLayout.hasGreeting && desktopLayout.hasModeTabs && desktopLayout.hasSidebarActions, 'rendered page missing Image #1 functional shell');
    assert(desktopLayout.hasCowork && desktopLayout.hasQuickActions, 'rendered page missing Agent cowork quick actions');
    assert(desktopLayout.hasInteractionStream, 'rendered page missing cowork interaction stream');
    assert(desktopLayout.hasRunCards, 'rendered page missing task card panel');
    assert(!desktopLayout.hasFrameworkOverlay, 'rendered page appears to show a framework error overlay');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'desktop layout has horizontal overflow');

    const screenshot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        document.querySelector('[data-mode="cowork"]').click();
        const deadline = Date.now() + 2000;
        function tick() {
          const coworkReady =
            document.body.dataset.view === "cowork" &&
            !document.querySelector(".cowork-panel")?.hidden;
          if (coworkReady) requestAnimationFrame(() => requestAnimationFrame(resolve));
          else if (Date.now() > deadline) reject(new Error("cowork view did not become visible"));
          else setTimeout(tick, 25);
        }
        tick();
      })`,
    );
    const compactLayout = readCompactLayout(await evaluate(
      sendPage,
      `(() => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const selectors = [".sidebar", ".hero", ".composer", ".cowork-panel", ".run-history-panel", ".task-grid", ".interaction-stream", ".approve-button"];
        const issues = [];
        for (const selector of selectors) {
          const rect = document.querySelector(selector)?.getBoundingClientRect();
          if (!rect) issues.push(selector + " missing");
          else if (rect.left < -1 || rect.top < -1 || rect.right > viewport.width + 1 || rect.bottom > viewport.height + 1) {
            issues.push(selector + " out of viewport " + JSON.stringify({
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom)
            }));
          }
        }
        return {
          viewport,
          issues,
          scroll: {
            width: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            height: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight
          }
        };
      })()`,
    ));
    assert(compactLayout.issues.length === 0, `compact layout issues: ${compactLayout.issues.join(', ')}`);
    assert(compactLayout.scroll.width <= compactLayout.scroll.clientWidth + 1, 'compact layout has horizontal overflow');
    assert(compactLayout.scroll.height <= compactLayout.scroll.clientHeight + 1, 'compact layout has vertical overflow');

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const interaction = readRenderedInteraction(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        document.querySelector('[data-mode="cowork"]').click();
        const textarea = document.querySelector(".composer textarea");
        const send = document.querySelector(".send-button");
        const approve = document.querySelector(".approve-button");
        if (!textarea || !send || !approve) reject(new Error("required controls missing"));
        textarea.value = "请读取本地工作区，生成合同摘要和整理计划";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
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

        waitFor(() => document.querySelector(".status-pill")?.innerText.includes("计划就绪"), 5000)
          .then(() => {
            const afterPlan = {
              status: document.querySelector(".status-pill")?.innerText.trim(),
              artifact: document.querySelector(".artifact-preview p")?.innerText,
              opCount: document.querySelectorAll(".diff-row").length,
              stream: document.querySelector(".interaction-stream")?.innerText,
              runCardCount: document.querySelectorAll(".run-card:not(.is-empty)").length,
              activeRunCard: document.querySelector(".run-card.is-active")?.innerText || "",
              runSummary: document.querySelector(".run-summary")?.innerText || ""
            };
            approve.click();
            return waitFor(() => document.querySelector(".status-pill")?.innerText.includes("已在本机执行"), 5000)
              .then(() => ({
                afterPlan,
                afterApprove: {
                  status: document.querySelector(".status-pill")?.innerText.trim(),
                  artifact: document.querySelector(".artifact-preview p")?.innerText,
                  approve: document.querySelector(".approve-button")?.innerText.trim(),
                  doneClass: document.querySelector(".approve-button")?.classList.contains("is-done"),
                  stream: document.querySelector(".interaction-stream")?.innerText
                }
              }));
          })
          .then(resolve, reject);
      })`,
    ));
    assert(interaction.afterPlan.status === '计划就绪', 'send interaction did not reach 计划就绪');
    assert(interaction.afterPlan.artifact.includes('renewal date'), 'plan did not include trusted file summary');
    assert(interaction.afterPlan.stream.includes('用户指令') && interaction.afterPlan.stream.includes('读取本地上下文'), 'plan interaction stream missing task steps');
    assert(interaction.afterPlan.stream.includes('等待审批'), 'plan interaction stream missing approval wait state');
    assert(interaction.afterPlan.runCardCount >= 1, 'plan did not render any task card');
    assert(interaction.afterPlan.activeRunCard.includes('协作') && interaction.afterPlan.activeRunCard.includes('完成'), 'active task card did not show cowork completion');
    assert(interaction.afterPlan.runSummary.includes('最近'), 'task card summary did not report recent runs');
    assert(interaction.afterApprove.status === '已在本机执行', 'approve interaction did not reach 已在本机执行');
    assert(interaction.afterApprove.doneClass === true, 'approve button did not enter done state');
    assert(interaction.afterApprove.stream.includes('执行完成'), 'approve interaction stream missing completion state');

    const artifactsDir = path.join(workspace, '.AgentCowork', 'artifacts');
    const artifacts = fs.existsSync(artifactsDir)
      ? fs.readdirSync(artifactsDir).filter((name) => name.endsWith('.md'))
      : [];
    assert(artifacts.length > 0, 'browser interaction did not write an artifact');
    const firstArtifact = artifacts[0];
    assert(firstArtifact, 'browser interaction did not write a readable artifact');
    const artifactContent = fs.readFileSync(path.join(artifactsDir, firstArtifact), 'utf8');
    assert(artifactContent.includes('来源摘要'), 'artifact missing source summary');
    assert(fs.readFileSync(auditPath, 'utf8').includes('"action":"write"'), 'audit log missing browser write action');

    const uploadAndChat = readUploadAndChat(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const currentState = () => JSON.stringify({
          mode: document.querySelector(".mode-tab.is-active")?.innerText.trim(),
          status: document.querySelector(".status-pill")?.innerText.trim(),
          artifact: document.querySelector(".artifact-preview p")?.innerText,
          chatHidden: document.querySelector(".chat-output")?.hidden
        });
        const waitFor = (predicate, timeoutMs) => new Promise((ok, fail) => {
          const deadline = Date.now() + timeoutMs;
          function tick() {
            try {
              if (predicate()) ok(true);
              else if (Date.now() > deadline) fail(new Error("timed out: " + currentState()));
              else setTimeout(tick, 50);
            } catch (error) {
              fail(error);
            }
          }
          tick();
        });

        const uploadInput = document.querySelector(".upload-input");
        if (!uploadInput) reject(new Error("upload input missing"));
        const dt = new DataTransfer();
        dt.items.add(new File(["invoice smoke amount=128"], "invoice-ui-smoke.txt", { type: "text/plain" }));
        uploadInput.files = dt.files;
        uploadInput.dispatchEvent(new Event("change", { bubbles: true }));

        waitFor(() => document.querySelector(".status-pill")?.innerText.includes("文件已导入"), 5000)
          .then(() => {
            const uploadState = {
              status: document.querySelector(".status-pill")?.innerText.trim(),
              artifact: document.querySelector(".artifact-preview p")?.innerText,
              files: Array.from(document.querySelectorAll(".file-list span")).map((node) => node.innerText)
            };
            document.querySelector('[data-mode="chat"]').click();
            const textarea = document.querySelector(".composer textarea");
            textarea.value = "请说明刚上传的文件可以怎么处理";
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            document.querySelector(".send-button").click();
            return waitFor(() => document.querySelector(".status-pill")?.innerText.includes("计划就绪"), 5000)
              .then(() => ({
                uploadState,
                taskState: {
                  activeMode: document.querySelector(".mode-tab.is-active")?.innerText.trim(),
                  status: document.querySelector(".status-pill")?.innerText.trim(),
                  artifact: document.querySelector(".artifact-preview p")?.innerText,
                  chatHidden: document.querySelector(".chat-output")?.hidden,
                  stream: document.querySelector(".interaction-stream")?.innerText,
                  runCardCount: document.querySelectorAll(".run-card:not(.is-empty)").length,
                  activeRunCard: document.querySelector(".run-card.is-active")?.innerText || ""
                }
              }));
          })
          .then(resolve, reject);
      })`,
    ));
    assert(uploadAndChat.uploadState.status === '文件已导入', 'upload interaction did not reach 文件已导入');
    assert(uploadAndChat.uploadState.artifact.includes('已上传 1 个文件'), 'upload interaction did not report imported file');
    assert(uploadAndChat.uploadState.files.some((name) => name.includes('invoice-ui-smoke.txt')), 'uploaded file was not visible in file list');
    assert(uploadAndChat.taskState.activeMode === '协作', 'chat send did not jump into cowork mode');
    assert(uploadAndChat.taskState.status === '计划就绪', 'chat send did not create a cowork plan');
    assert(uploadAndChat.taskState.artifact.includes('invoice smoke amount=128'), 'cowork plan did not use uploaded file summary');
    assert(uploadAndChat.taskState.stream.includes('invoice smoke amount=128'), 'cowork interaction stream did not show uploaded file context');
    assert(uploadAndChat.taskState.stream.includes('等待审批'), 'cowork interaction stream did not show approval state after chat handoff');
    assert(uploadAndChat.taskState.runCardCount >= 2, 'cowork handoff did not append a task card');
    assert(uploadAndChat.taskState.activeRunCard.includes('协作') && uploadAndChat.taskState.activeRunCard.includes('完成'), 'cowork handoff did not highlight latest task card');
    assert(uploadAndChat.taskState.chatHidden === true, 'chat output should stay hidden after cowork task handoff');
    const uploadRoot = path.join(workspace, 'Agent_Cowork上传');
    const uploadedFiles = listFilesRecursive(uploadRoot, (name) => name.endsWith('invoice-ui-smoke.txt'));
    assert(uploadedFiles.length === 1, 'browser upload did not persist file into Agent_Cowork上传');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      baseUrl,
      browserPath,
      workspace,
      screenshotPath,
      desktopLayout,
      compactLayout,
      interaction,
      uploadAndChat,
      artifacts: artifacts.map((name) => path.join(artifactsDir, name)),
      auditPath,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      baseUrl,
      browserPath,
      workspace,
      error: errorDetails(error),
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(errorDetails(error));
    process.exitCode = 1;
  } finally {
    client?.close();
    browser.kill();
    await new Promise<void>((resolve, reject) => {
      host.close((error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the report keeps the workspace artifacts for inspection.
    }
  }
}

main().catch((error) => {
  console.error(errorDetails(error));
  process.exit(1);
});
