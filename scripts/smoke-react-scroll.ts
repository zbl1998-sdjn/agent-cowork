// React 时间线滚动锚定 smoke(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:验证 FE-1 滚动行为——用无头浏览器拉起 host server 与 React UI,预置
//       36 轮对话使时间线溢出,初始应停在底部;手动滚到顶部后发送一条消息触发
//       流式回复(由注入的 agentModelCall 假流式产出),断言流式追加时不把正在
//       看历史的用户拽到底部、且出现"回到底部"按钮;点击按钮后回到底部、按钮消失;
//       末尾截图并写出 JSON 报告。
// 用法:由对应 npm script 经 run-host-node 触发;置 REACT_SCROLL_ARCHIVE=1 时把
//       报告归档到 reports/react-scroll。
// 依赖:apps/host/src/server.js、./browser-smoke-utils;需先 npm run build:ui。
//       失败即 exit 1。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
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
const uiDistRoot = path.join(repoRoot, 'apps', 'windows-client', 'ui-dist');
const defaultReportPath = path.join(buildDir, 'react-scroll-smoke-report.json');
const archiveRequested = process.env.REACT_SCROLL_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_SCROLL_REPORT_DIR || path.join(repoRoot, 'reports', 'react-scroll'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-scroll-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-scroll-smoke-1280x760.png');

type ScrollMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'done';
  progress?: unknown[];
  operations?: unknown[];
  sources?: unknown[];
  approvalState?: 'idle';
};

type ScrollConversation = {
  id: string;
  title: string;
  messages: ScrollMessage[];
};

type ScrollSnapshot = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  bubbleCount: number;
  buttonVisible: boolean;
  jumpVisible: boolean;
  hasStartMarker: boolean;
  hasDoneMarker: boolean;
  buttonText: string;
};

type ScrollModelCallArgs = {
  onContent?: (chunk: string) => void;
};

function scrollSnapshot(value: unknown, label: string): ScrollSnapshot {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    scrollTop: typeof value.scrollTop === 'number' ? value.scrollTop : 0,
    scrollHeight: typeof value.scrollHeight === 'number' ? value.scrollHeight : 0,
    clientHeight: typeof value.clientHeight === 'number' ? value.clientHeight : 0,
    distanceFromBottom: typeof value.distanceFromBottom === 'number' ? value.distanceFromBottom : 0,
    bubbleCount: typeof value.bubbleCount === 'number' ? value.bubbleCount : 0,
    buttonVisible: value.buttonVisible === true,
    jumpVisible: value.jumpVisible === true,
    hasStartMarker: value.hasStartMarker === true,
    hasDoneMarker: value.hasDoneMarker === true,
    buttonText: typeof value.buttonText === 'string' ? value.buttonText : '',
  };
}

function seededConversations(): ScrollConversation[] {
  const messages: ScrollMessage[] = [];
  for (let i = 1; i <= 36; i += 1) {
    messages.push({
      id: `seed-user-${i}`,
      role: 'user',
      text: `Seed user message ${i}: keep enough history above the fold for FE-1 scroll validation.`,
    });
    messages.push({
      id: `seed-assistant-${i}`,
      role: 'assistant',
      status: 'done',
      text: [
        `Seed assistant message ${i}.`,
        'This paragraph intentionally fills vertical space so the React timeline overflows.',
        'A user reading older context must not be pulled to the newest streaming answer.',
      ].join('\n'),
      progress: [],
      operations: [],
      sources: [],
      approvalState: 'idle',
    });
  }
  return [{ id: 'scroll-conv', title: 'FE-1 scroll smoke', messages }];
}

function makeScrollModelCall() {
  const responseText = [
    'FE-1 stream marker start.',
    ...Array.from({ length: 28 }, (_, i) => (
      `Streaming line ${i + 1}: this token batch is appended while the user is intentionally reading the top of the conversation.`
    )),
    'FE-1 stream marker done.',
  ].join('\n');

  return async ({ onContent }: ScrollModelCallArgs) => {
    for (let i = 0; i < responseText.length; i += 90) {
      const chunk = responseText.slice(i, i + 90);
      if (chunk) onContent?.(chunk);
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    return {
      content: responseText,
      usage: { prompt_tokens: 12, completion_tokens: 48, total_tokens: 60 },
    };
  };
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  assert(fs.existsSync(path.join(uiDistRoot, 'index.html')), 'React UI dist is missing; run npm run build:ui first');
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for React scroll smoke');

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-scroll-'));
  fs.writeFileSync(path.join(workspace, 'notes.md'), '# Scroll smoke workspace\n', 'utf8');
  const host = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    uiDistRoot,
    agentModelCall: makeScrollModelCall(),
    modelChatRunner: async () => ({ ok: true, provider: 'kimi-api', model: 'kimi-test', mode: 'chat', text: 'dry-run', durationMs: 1 }),
    modelPlanRunner: async () => ({ ok: true, provider: 'kimi-api', model: 'kimi-test', mode: 'plan', text: 'dry-run', durationMs: 1 }),
  });

  const startedAt = Date.now();
  let baseUrl: string | null = null;
  let browser: ChildProcessLike | null = null;
  let client: CdpClient | null = null;
  let userDataDir: string | null = null;
  const stderr: string[] = [];

  try {
    baseUrl = await bind(host);
    const debugPort = await getFreePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-scroll-profile-'));
    browser = spawn(
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
    browser.stderr.on('data', (chunk) => {
      stderr.push(chunk.toString());
    });

    const version = await getJson<CdpVersion>(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send<CdpTarget>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<CdpSession>('Target.attachToTarget', { targetId, flatten: true });
    const sendPage: SendPage = (method, params = {}) => {
      assert(client, 'DevTools client closed unexpectedly');
      return client.send(method, params, sessionId);
    };

    await sendPage('Page.enable');
    await sendPage('Runtime.enable');
    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sendPage('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        localStorage.setItem('kcw.guest', '1');
        localStorage.setItem('kcw.conversations.v1', ${JSON.stringify(JSON.stringify(seededConversations()))});
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const timeline = document.querySelector('.timeline');
          const textarea = document.querySelector('.composer textarea');
          const ready = timeline && textarea && timeline.scrollHeight > timeline.clientHeight + 300;
          if (ready) resolve(true);
          else if (Date.now() > deadline) reject(new Error('React timeline did not render seeded overflow content'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const initial = scrollSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        const startedAt = Date.now();
        let firstBottomAt = 0;
        function metrics() {
          const el = document.querySelector('.timeline');
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
            bubbleCount: document.querySelectorAll('.bubble').length
          };
        }
        function tick() {
          const current = metrics();
          if (current.distanceFromBottom <= 4) {
            if (!firstBottomAt) firstBottomAt = Date.now();
            if (Date.now() - firstBottomAt >= 250 && Date.now() - startedAt >= 700) resolve(current);
            else setTimeout(tick, 50);
          }
          else {
            firstBottomAt = 0;
            if (Date.now() > deadline) reject(new Error('timeline did not initialize at bottom: ' + JSON.stringify(current)));
            else setTimeout(tick, 50);
          }
        }
        tick();
      })`,
    ), 'initial');

    const scrolledAway = scrollSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve) => {
        const el = document.querySelector('.timeline');
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve({
            scrollTop: el.scrollTop,
            distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
            buttonVisible: Boolean(document.querySelector('.jump-to-bottom'))
          });
        }));
      })`,
    ), 'scrolledAway');

    await evaluate(
      sendPage,
      `(() => {
        const textarea = document.querySelector('.composer textarea');
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setValue.call(textarea, 'Append a streaming FE-1 scroll smoke answer');
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textarea.value }));
        document.querySelector('.send-button').click();
        return true;
      })()`,
    );

    const afterStream = scrollSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const el = document.querySelector('.timeline');
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
            jumpVisible: Boolean(document.querySelector('.jump-to-bottom')),
            hasStartMarker: document.body.innerText.includes('FE-1 stream marker start.'),
            hasDoneMarker: document.body.innerText.includes('FE-1 stream marker done.'),
            buttonText: document.querySelector('.jump-to-bottom')?.innerText || '',
            bubbleCount: document.querySelectorAll('.bubble').length
          };
        }
        function tick() {
          const current = snapshot();
          if (current.hasDoneMarker && current.jumpVisible) resolve(current);
          else if (Date.now() > deadline) reject(new Error('stream did not finish with jump button visible: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ), 'afterStream');

    await evaluate(
      sendPage,
      `(() => {
        document.querySelector('.jump-to-bottom')?.click();
        return true;
      })()`,
    );

    const afterJump = scrollSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 3000;
        function snapshot() {
          const el = document.querySelector('.timeline');
          return {
            scrollTop: el.scrollTop,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
            jumpVisible: Boolean(document.querySelector('.jump-to-bottom'))
          };
        }
        function tick() {
          const current = snapshot();
          if (current.distanceFromBottom <= 48 && !current.jumpVisible) resolve(current);
          else if (Date.now() > deadline) reject(new Error('jump-to-bottom did not return to bottom: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ), 'afterJump');

    assert(initial.bubbleCount >= 60, 'seeded conversation did not render enough timeline messages');
    assert(scrolledAway.distanceFromBottom > 300, 'manual scroll did not leave the bottom');
    assert(afterStream.hasStartMarker && afterStream.hasDoneMarker, 'streamed assistant text was not rendered');
    assert(afterStream.distanceFromBottom > 300, 'timeline jumped back to bottom while user was reading history');
    assert(afterStream.jumpVisible, 'jump-to-bottom button did not appear for new content away from bottom');
    assert(afterJump.distanceFromBottom <= 48, 'jump-to-bottom button did not scroll near bottom');
    assert(!afterJump.jumpVisible, 'jump-to-bottom button stayed visible after returning to bottom');

    const screenshot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      screenshotPath,
      reportPath,
      initial,
      scrolledAway,
      afterStream,
      afterJump,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshotPath, afterStream, afterJump }, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      reportPath,
      error: errorDetails(error),
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(errorDetails(error));
    process.exitCode = 1;
  } finally {
    client?.close();
    if (browser) browser.kill();
    await new Promise((resolve) => host.close(resolve));
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    reportPath,
    error: errorDetails(error),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(errorDetails(error));
  process.exit(1);
});
