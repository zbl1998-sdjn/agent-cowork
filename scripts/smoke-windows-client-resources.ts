import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import type { ChildProcessLike } from 'node:child_process';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const resourcesDir = path.join(repoRoot, 'apps', 'windows-client', 'resources');
const indexPath = path.join(resourcesDir, 'index.html');
const reportPath = path.join(buildDir, 'windows-client-resource-smoke-report.json');
const screenshotPath = path.join(buildDir, 'windows-client-resource-smoke-1536x900.png');

type ScrollMetrics = {
  width: number;
  clientWidth: number;
  height: number;
  clientHeight: number;
};

type DesktopLayout = {
  title: string;
  protocol: string;
  hostApi: boolean;
  status: string;
  activeMode: string;
  hasGreeting: boolean;
  hasCowork: boolean;
  hasModeTabs: boolean;
  hasSidebarActions: boolean;
  hasQuickActions: boolean;
  hasInteractionStream: boolean;
  hasRunCards: boolean;
  scroll: ScrollMetrics;
};

type CompactLayout = {
  viewport: { width: number; height: number };
  issues: string[];
  scroll: ScrollMetrics;
};

type ResourceInteraction = {
  afterPlan: {
    status: string;
    artifact: string;
    operationCount: number;
    stream: string;
  };
  afterApprove: {
    status: string;
    artifact: string;
    approve: string;
    doneClass: boolean;
    stream: string;
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
    protocol: typeof value.protocol === 'string' ? value.protocol : '',
    hostApi: value.hostApi === true,
    status: typeof value.status === 'string' ? value.status : '',
    activeMode: typeof value.activeMode === 'string' ? value.activeMode : '',
    hasGreeting: value.hasGreeting === true,
    hasCowork: value.hasCowork === true,
    hasModeTabs: value.hasModeTabs === true,
    hasSidebarActions: value.hasSidebarActions === true,
    hasQuickActions: value.hasQuickActions === true,
    hasInteractionStream: value.hasInteractionStream === true,
    hasRunCards: value.hasRunCards === true,
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

function readInteraction(value: unknown): ResourceInteraction {
  if (!isRecord(value)) throw new TypeError('interaction snapshot must be an object');
  const afterPlan = isRecord(value.afterPlan) ? value.afterPlan : {};
  const afterApprove = isRecord(value.afterApprove) ? value.afterApprove : {};
  return {
    afterPlan: {
      status: typeof afterPlan.status === 'string' ? afterPlan.status : '',
      artifact: typeof afterPlan.artifact === 'string' ? afterPlan.artifact : '',
      operationCount: typeof afterPlan.operationCount === 'number' ? afterPlan.operationCount : 0,
      stream: typeof afterPlan.stream === 'string' ? afterPlan.stream : '',
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

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  assert(fs.existsSync(indexPath), `Windows client resource entry is missing: ${indexPath}`);
  assert(fs.existsSync(path.join(resourcesDir, 'app.css')), 'Windows client CSS resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-composer-sources.js')), 'Windows client composer sources resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-composer-popover.js')), 'Windows client composer popover resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-artifacts.js')), 'Windows client artifacts resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-run-history.js')), 'Windows client run history resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-workbench-renderer.js')), 'Windows client workbench renderer resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-task-context.js')), 'Windows client task context resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-kimi-runner.js')), 'Windows client Kimi runner resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-message-renderer.js')), 'Windows client message renderer resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-chat-runner.js')), 'Windows client chat runner resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-approval-runner.js')), 'Windows client approval runner resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-message-actions.js')), 'Windows client message actions resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-recipe-runner.js')), 'Windows client recipe runner resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-file-upload.js')), 'Windows client file upload resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app.js')), 'Windows client JS resource is missing');

  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for Windows client resource smoke');

  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-windows-resource-profile-'));
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
      '--allow-file-access-from-files',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  const stderr: string[] = [];
  browser.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  let client: CdpClient | undefined;
  const resourceUrl = pathToFileURL(indexPath).href;
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
    await sendPage('Page.navigate', { url: resourceUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        function tick() {
          if (document.readyState === "complete" && document.body.innerText.includes("欢迎回来，Derrick")) resolve(true);
          else if (Date.now() > deadline) reject(new Error("windows resource page did not render"));
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
        const state = window.agentCowork || {};
        return {
          title: document.title,
          protocol: window.location.protocol,
          hostApi: state.hostApi,
          status: document.querySelector(".status-pill")?.innerText.trim(),
          activeMode: document.querySelector(".mode-tab.is-active")?.innerText.trim(),
          hasGreeting: text.includes("欢迎回来，Derrick"),
          hasCowork: text.includes("Agent Cowork"),
          hasModeTabs: text.includes("对话") && text.includes("协作") && text.includes("代码"),
          hasSidebarActions: text.includes("新建会话") && text.includes("项目") && text.includes("产物") && text.includes("自定义"),
          hasQuickActions: text.includes("学习") && text.includes("写作") && text.includes("Kimi 推荐") && text.includes("上传文件夹"),
          hasInteractionStream: document.querySelector(".interaction-stream")?.textContent.includes("执行动态") === true,
          hasRunCards: document.querySelector(".run-history-panel")?.textContent.includes("任务卡片") === true,
          scroll
        };
      })()`,
    ));
    assert(desktopLayout.title === 'Agent Cowork', 'Windows resource title mismatch');
    assert(desktopLayout.protocol === 'file:', 'Windows resource smoke must load via file:// static resource mode');
    assert(desktopLayout.hostApi === false, 'Windows resource static preview should not call Host API');
    assert(desktopLayout.status === '静态预览', 'Windows resource did not enter static preview status');
    assert(desktopLayout.activeMode === '对话', 'Windows resource should default to 对话 mode');
    assert(desktopLayout.hasGreeting && desktopLayout.hasModeTabs && desktopLayout.hasSidebarActions, 'Windows resource missing Image #1 functional shell');
    assert(desktopLayout.hasCowork && desktopLayout.hasQuickActions, 'Windows resource missing expected Kimi controls');
    assert(desktopLayout.hasInteractionStream, 'Windows resource missing cowork interaction stream');
    assert(desktopLayout.hasRunCards, 'Windows resource missing task card panel');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'Windows desktop resource layout has horizontal overflow');

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
            issues.push(selector + " out of viewport");
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
    assert(compactLayout.issues.length === 0, `Windows compact resource layout issues: ${compactLayout.issues.join(', ')}`);
    assert(compactLayout.scroll.width <= compactLayout.scroll.clientWidth + 1, 'Windows compact resource layout has horizontal overflow');
    assert(compactLayout.scroll.height <= compactLayout.scroll.clientHeight + 1, 'Windows compact resource layout has vertical overflow');

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const interaction = readInteraction(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        document.querySelector('[data-mode="cowork"]').click();
        const textarea = document.querySelector(".composer textarea");
        const send = document.querySelector(".send-button");
        const approve = document.querySelector(".approve-button");
        if (!textarea || !send || !approve) reject(new Error("required controls missing"));
        textarea.value = "预览 Windows C 客户端资源操作";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        setTimeout(() => {
          const afterPlan = {
            status: document.querySelector(".status-pill")?.innerText.trim(),
            artifact: document.querySelector(".artifact-preview p")?.innerText,
            operationCount: document.querySelectorAll(".diff-row").length,
            stream: document.querySelector(".interaction-stream")?.innerText
          };
          approve.click();
          setTimeout(() => {
            resolve({
              afterPlan,
              afterApprove: {
                status: document.querySelector(".status-pill")?.innerText.trim(),
                artifact: document.querySelector(".artifact-preview p")?.innerText,
                approve: document.querySelector(".approve-button")?.innerText.trim(),
                doneClass: document.querySelector(".approve-button")?.classList.contains("is-done"),
                stream: document.querySelector(".interaction-stream")?.innerText
              }
            });
          }, 100);
        }, 100);
      })`,
    ));
    assert(interaction.afterPlan.status === '预览模式', 'Windows resource send did not enter 预览模式');
    assert(interaction.afterPlan.artifact.includes('Windows C 客户端资源操作'), 'Windows resource prompt was not reflected in preview');
    assert(interaction.afterPlan.stream.includes('用户指令') && interaction.afterPlan.stream.includes('静态预览'), 'Windows resource stream missing static preview steps');
    assert(interaction.afterApprove.status === '预览已应用', 'Windows resource approve did not enter 预览已应用');
    assert(interaction.afterApprove.doneClass === true, 'Windows resource approve button did not enter done state');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      resourceUrl,
      browserPath,
      resourcesDir,
      screenshotPath,
      desktopLayout,
      compactLayout,
      interaction,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      resourceUrl,
      browserPath,
      resourcesDir,
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
