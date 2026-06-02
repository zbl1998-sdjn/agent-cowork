// React 会话分支切换 smoke(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:用无头浏览器拉起 host server 与 React UI,预置一条含主线与分支 b1 的会话
//       (共同节点 + 各自独有标记),验证分支下拉框渲染、切到分支后时间线只显示
//       分支消息且出现分支差异摘要、切回主线后元数据恢复("4 条消息"),
//       全程用 DOM 标记断言;最后截图并写出 JSON 报告。
// 用法:由对应 npm script 经 run-host-node 触发;置 REACT_BRANCHES_ARCHIVE=1
//       时把报告归档到 reports/react-branches。
// 依赖:apps/host/src/server.js、./browser-smoke-utils;需先 npm run build:ui
//       产出 ui-dist。失败即 exit 1。
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
const defaultReportPath = path.join(buildDir, 'react-branches-smoke-report.json');
const archiveRequested = process.env.REACT_BRANCHES_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_BRANCHES_REPORT_DIR || path.join(repoRoot, 'reports', 'react-branches'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-branches-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-branches-smoke-1280x760.png');

type BranchMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'done';
  progress?: unknown[];
  operations?: unknown[];
  sources?: unknown[];
  approvalState?: 'idle';
};
type BranchConversation = {
  id: string;
  title: string;
  messages: BranchMessage[];
  activeBranchId: string;
  branches: {
    id: string;
    title: string;
    parentBranchId?: string;
    baseMessageId?: string;
    createdAt?: string;
    messages: BranchMessage[];
  }[];
};
type BranchSnapshot = {
  selected: string;
  optionLabels: string[];
  meta: string;
  hasMain: boolean;
  hasBranch: boolean;
  timeline: string;
};

function branchSnapshot(value: unknown, label: string): BranchSnapshot {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    selected: typeof value.selected === 'string' ? value.selected : '',
    optionLabels: Array.isArray(value.optionLabels) ? value.optionLabels.filter((item): item is string => typeof item === 'string') : [],
    meta: typeof value.meta === 'string' ? value.meta : '',
    hasMain: value.hasMain === true,
    hasBranch: value.hasBranch === true,
    timeline: typeof value.timeline === 'string' ? value.timeline : '',
  };
}

function assistant(id: string, text: string): BranchMessage {
  return { id, role: 'assistant', status: 'done', text, progress: [], operations: [], sources: [], approvalState: 'idle' };
}

function seededConversations(): BranchConversation[] {
  const common: BranchMessage[] = [
    { id: 'u-root', role: 'user', text: 'COMMON_NODE_MARKER 共同节点：准备季度报告' },
    assistant('a-root', 'COMMON_ASSISTANT_MARKER 共同上下文：先确认受众和摘要结构。'),
  ];
  const mainMessages: BranchMessage[] = [
    ...common,
    { id: 'u-main', role: 'user', text: 'MAIN_ONLY_MARKER 主线继续：预算版本' },
    assistant('a-main', 'MAIN_ASSISTANT_MARKER 主线回复：使用预算版叙事。'),
  ];
  const branchMessages: BranchMessage[] = [
    ...common,
    { id: 'u-branch', role: 'user', text: 'BRANCH_ONLY_MARKER 分支继续：董事会版本' },
    assistant('a-branch', 'BRANCH_ASSISTANT_MARKER 分支回复：使用董事会版叙事。'),
  ];

  return [{
    id: 'branch-smoke-conv',
    title: '05-B1b branch smoke',
    messages: mainMessages,
    activeBranchId: 'main',
    branches: [
      { id: 'main', title: '主线', messages: mainMessages },
      {
        id: 'b1',
        title: '分支 1',
        parentBranchId: 'main',
        baseMessageId: 'u-main',
        createdAt: '2026-05-24T00:00:00.000Z',
        messages: branchMessages,
      },
    ],
  }];
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  assert(fs.existsSync(path.join(uiDistRoot, 'index.html')), 'React UI dist is missing; run npm run build:ui first');
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for React branches smoke');

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-branches-'));
  fs.writeFileSync(path.join(workspace, 'notes.md'), '# Branch smoke workspace\n', 'utf8');
  const host = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    uiDistRoot,
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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-branches-profile-'));
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
    browser.stderr.on('data', (chunk) => { stderr.push(chunk.toString()); });

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
          const workspaceReady = document.querySelector('.workspace-chip')?.getAttribute('title')?.includes(${JSON.stringify(workspace)});
          const ready = document.querySelector('.conv-branch-select') &&
            document.body.innerText.includes('MAIN_ONLY_MARKER') &&
            workspaceReady;
          if (ready) resolve(true);
          else if (Date.now() > deadline) reject(new Error('React branch smoke shell did not become ready'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const initialMain = branchSnapshot(await evaluate(
      sendPage,
      `(() => {
        const select = document.querySelector('.conv-branch-select');
        const meta = document.querySelector('.conv-branch-meta');
        return {
          selected: select?.value || '',
          optionLabels: [...(select?.options || [])].map((option) => option.text),
          meta: meta?.innerText || '',
          hasMain: document.body.innerText.includes('MAIN_ONLY_MARKER'),
          hasBranch: document.body.innerText.includes('BRANCH_ONLY_MARKER')
        };
      })()`,
    ), 'initialMain');

    await evaluate(
      sendPage,
      `(() => {
        const select = document.querySelector('.conv-branch-select');
        if (!select) throw new Error('branch selector missing');
        select.value = 'b1';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );

    const branchView = branchSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const select = document.querySelector('.conv-branch-select');
          const meta = document.querySelector('.conv-branch-meta');
          return {
            selected: select?.value || '',
            meta: meta?.innerText || '',
            hasMain: document.body.innerText.includes('MAIN_ONLY_MARKER'),
            hasBranch: document.body.innerText.includes('BRANCH_ONLY_MARKER'),
            timeline: document.querySelector('.timeline')?.innerText || ''
          };
        }
        function tick() {
          const current = snapshot();
          if (current.selected === 'b1' && current.hasBranch && !current.hasMain) resolve(current);
          else if (Date.now() > deadline) reject(new Error('branch switch did not update timeline: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ), 'branchView');

    await evaluate(
      sendPage,
      `(() => {
        const select = document.querySelector('.conv-branch-select');
        if (!select) throw new Error('branch selector missing for return');
        select.value = 'main';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );

    const returnedMain = branchSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const select = document.querySelector('.conv-branch-select');
          const meta = document.querySelector('.conv-branch-meta');
          return {
            selected: select?.value || '',
            meta: meta?.innerText || '',
            hasMain: document.body.innerText.includes('MAIN_ONLY_MARKER'),
            hasBranch: document.body.innerText.includes('BRANCH_ONLY_MARKER'),
            timeline: document.querySelector('.timeline')?.innerText || ''
          };
        }
        function tick() {
          const current = snapshot();
          if (current.selected === 'main' && current.hasMain && !current.hasBranch) resolve(current);
          else if (Date.now() > deadline) reject(new Error('return to main branch did not update timeline: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ), 'returnedMain');

    assert(initialMain.selected === 'main', 'seeded conversation did not start on main branch');
    assert(initialMain.optionLabels?.includes('主线') && initialMain.optionLabels.includes('分支 1'), 'branch options were not rendered');
    assert(initialMain.hasMain && !initialMain.hasBranch, 'initial timeline did not show only main branch messages');
    assert(branchView.meta.includes('共同上下文') && branchView.meta.includes('分支差异'), 'branch diff summary was not visible after switching');
    assert(returnedMain.meta.includes('4 条消息'), 'main branch metadata was not restored after returning');

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
      initialMain,
      branchView,
      returnedMain,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshotPath, initialMain, branchView, returnedMain }, null, 2));
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
