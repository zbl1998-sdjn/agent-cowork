// React 实时活页产物 smoke(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:用无头浏览器拉起 host server 与 React UI,在"可视化"侧栏渲染一个绑定
//       文件数据源(data/live.json)的活页(table 可视化 iframe);随后改写磁盘
//       数据源、开启自动刷新(间隔 1s),通过 hook 后的 window.fetch 监控
//       /api/artifacts/data/ 请求,断言自动刷新拉到了更新后的数据(before→after);
//       并单独打开 /api/artifacts/live/<id> 独立页,点刷新验证表格更新;末尾截图
//       并写出 JSON 报告。
// 用法:由对应 npm script 经 run-host-node 触发;置 REACT_LIVE_ARTIFACT_ARCHIVE=1
//       时把报告归档到 reports/react-live-artifact。
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
const defaultReportPath = path.join(buildDir, 'react-live-artifact-smoke-report.json');
const archiveRequested = process.env.REACT_LIVE_ARTIFACT_ARCHIVE === '1';
const reportRoot = path.resolve(
  process.env.REACT_LIVE_ARTIFACT_REPORT_DIR || path.join(repoRoot, 'reports', 'react-live-artifact'),
);
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-live-artifact-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-live-artifact-smoke-1280x760.png');

type LiveFrameSnapshot = {
  srcdoc: string;
  dataUrl: string;
};

type LiveArtifactFetch = {
  url: string | undefined;
  body: unknown;
};

type AutoRefreshUi = {
  label: string;
  status: string;
  interval: string;
};

function liveFrameSnapshot(value: unknown, label: string): LiveFrameSnapshot {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    srcdoc: typeof value.srcdoc === 'string' ? value.srcdoc : '',
    dataUrl: typeof value.dataUrl === 'string' ? value.dataUrl : '',
  };
}

function liveFetchSnapshot(value: unknown, label: string): LiveArtifactFetch {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    url: typeof value.url === 'string' ? value.url : undefined,
    body: value.body,
  };
}

function autoRefreshSnapshot(value: unknown, label: string): AutoRefreshUi {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    label: typeof value.label === 'string' ? value.label : '',
    status: typeof value.status === 'string' ? value.status : '',
    interval: typeof value.interval === 'string' ? value.interval : '',
  };
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  assert(fs.existsSync(path.join(uiDistRoot, 'index.html')), 'React UI dist is missing; run npm run build:ui first');
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for React live artifact smoke');

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-live-artifact-'));
  const dataDir = path.join(workspace, 'data');
  const dataSourcePath = path.join(dataDir, 'live.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    dataSourcePath,
    `${JSON.stringify({
      viz: {
        title: 'Live table',
        kind: 'table',
        data: { columns: ['metric', 'value'], rows: [['before', '1']] },
      },
    }, null, 2)}\n`,
    'utf8',
  );

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
  let beforeRefresh = '';
  let afterRefresh = '';
  let autoRefreshFetch: LiveArtifactFetch | null = null;
  let livePageBefore = '';
  let livePageAfter = '';
  const stderr: string[] = [];

  try {
    baseUrl = await bind(host);
    const debugPort = await getFreePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-live-artifact-profile-'));
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
        localStorage.setItem('kcw.conversations.v1', JSON.stringify([{ id: 'live-artifact-smoke-conv', title: '03-B1 live artifact smoke', messages: [] }]));
        const originalFetch = window.fetch.bind(window);
        window.__kcwLiveFetches = [];
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          try {
            const rawUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
            const url = String(rawUrl || '');
            if (url.includes('/api/artifacts/data/')) {
              const body = await response.clone().json();
              window.__kcwLiveFetches.push({ url, body });
            }
          } catch {
            // Keep smoke fetch instrumentation transparent to the app.
          }
          return response;
        };
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const headerReady = [...document.querySelectorAll('button')].some((button) => button.innerText.trim() === '可视化');
          const workspaceReady = document.querySelector('.workspace-chip')?.getAttribute('title')?.includes(${JSON.stringify(workspace)});
          if (headerReady && workspaceReady) resolve(true);
          else if (Date.now() > deadline) reject(new Error('React shell did not become ready for live artifact smoke'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '可视化');
        if (!button) throw new Error('visualization panel button not found');
        button.click();
        return true;
      })()`,
    );

    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          if (document.querySelector('.side-panel textarea')) resolve(true);
          else if (Date.now() > deadline) reject(new Error('visualization panel did not finish loading'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const vizSpec = {
      title: 'Live table',
      kind: 'table',
      data: { columns: ['metric', 'value'], rows: [['before', '1']] },
      dataSource: { type: 'file-json', path: 'data/live.json' },
    };
    await evaluate(
      sendPage,
      `(() => {
        const textarea = document.querySelector('.side-panel textarea');
        if (!textarea) throw new Error('viz textarea missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setValue.call(textarea, ${JSON.stringify(JSON.stringify(vizSpec, null, 2))});
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'spec' }));
        const renderButton = [...document.querySelectorAll('.side-panel button')].find((button) => button.innerText.trim() === '渲染活页');
        if (!renderButton) throw new Error('render live artifact button missing');
        renderButton.click();
        return true;
      })()`,
    );

    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 9000;
        function tick() {
          if (document.querySelector('.viz-frame')) resolve(true);
          else if (Date.now() > deadline) reject(new Error('live artifact iframe was not mounted'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const initialFrame = liveFrameSnapshot(await evaluate(
      sendPage,
      `(() => {
        const frame = document.querySelector('.viz-frame');
        const srcdoc = frame?.getAttribute('srcdoc') || '';
        const dataUrl = srcdoc.match(/var DATA_URL = "([^"]+)"/)?.[1] || '';
        return { srcdoc, dataUrl };
      })()`,
    ), 'initialFrame');
    assert(initialFrame.srcdoc.includes('before') && initialFrame.srcdoc.includes('1'), 'initial iframe srcDoc lacks seeded table data');
    assert(initialFrame.dataUrl.includes('/api/artifacts/data/'), `live artifact data URL missing from srcDoc: ${initialFrame.dataUrl}`);
    beforeRefresh = initialFrame.srcdoc.slice(0, 800);

    fs.writeFileSync(
      dataSourcePath,
      `${JSON.stringify({
        viz: {
          title: 'Live table',
          kind: 'table',
          data: { columns: ['metric', 'value'], rows: [['after', '42']] },
        },
      }, null, 2)}\n`,
      'utf8',
    );

    await evaluate(
      sendPage,
      `(() => {
        const interval = document.querySelector('input[aria-label="自动刷新间隔秒"]');
        const checkbox = document.querySelector('.live-artifact-auto input[type="checkbox"]');
        if (!interval) throw new Error('auto refresh interval input missing');
        if (!checkbox) throw new Error('auto refresh checkbox missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(interval, '1');
        interval.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '1' }));
        if (!checkbox.checked) checkbox.click();
        return true;
      })()`,
    );

    autoRefreshFetch = liveFetchSnapshot(await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function hasUpdatedBody(entry) {
          const rows = entry?.body?.viz?.data?.rows || [];
          return rows.some((row) => Array.isArray(row) && row.includes('after') && row.includes('42'));
        }
        function tick() {
          const hit = (window.__kcwLiveFetches || []).find(hasUpdatedBody);
          if (hit) resolve(hit);
          else if (Date.now() > deadline) reject(new Error('auto refresh did not fetch updated live artifact data: ' + JSON.stringify(window.__kcwLiveFetches || [])));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    ), 'autoRefreshFetch');

    const autoRefreshUi = autoRefreshSnapshot(await evaluate(
      sendPage,
      `(() => ({
        label: document.querySelector('.live-artifact-auto')?.innerText || '',
        status: document.querySelector('.live-artifact-view .panel-note')?.innerText || '',
        interval: document.querySelector('input[aria-label="自动刷新间隔秒"]')?.value || ''
      }))()`,
    ), 'autoRefreshUi');
    assert(autoRefreshUi.label.includes('自动刷新 1s'), `auto refresh label did not update: ${autoRefreshUi.label}`);
    assert(autoRefreshUi.interval === '1', `auto refresh interval did not remain at 1: ${autoRefreshUi.interval}`);

    const liveId = initialFrame.dataUrl.split('/').pop();
    assert(liveId, `could not derive live artifact id from ${initialFrame.dataUrl}`);
    const liveUrl = `${baseUrl}/api/artifacts/live/${encodeURIComponent(liveId)}`;
    const { targetId: liveTargetId } = await client.send<CdpTarget>('Target.createTarget', { url: liveUrl });
    const { sessionId: liveSessionId } = await client.send<CdpSession>('Target.attachToTarget', { targetId: liveTargetId, flatten: true });
    const sendLivePage: SendPage = (method, params = {}) => {
      assert(client, 'DevTools client closed unexpectedly');
      return client.send(method, params, liveSessionId);
    };
    await sendLivePage('Page.enable');
    await sendLivePage('Runtime.enable');
    livePageBefore = String(await evaluate(
      sendLivePage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const text = document.body?.innerText || '';
          if (text.includes('before') && text.includes('1')) resolve(text);
          else if (Date.now() > deadline) reject(new Error('standalone live artifact did not show initial table: ' + text));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    ));
    await evaluate(
      sendLivePage,
      `(() => {
        const button = document.getElementById('refresh');
        if (!button) throw new Error('standalone live artifact refresh button missing');
        button.click();
        return true;
      })()`,
    );
    livePageAfter = String(await evaluate(
      sendLivePage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const text = document.body?.innerText || '';
          if (text.includes('after') && text.includes('42')) resolve(text);
          else if (Date.now() > deadline) reject(new Error('standalone live artifact did not render refreshed table: ' + text));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    ));
    afterRefresh = livePageAfter;

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
      dataSourcePath,
      screenshotPath,
      reportPath,
      beforeRefresh,
      afterRefresh,
      autoRefreshFetch,
      livePageBefore,
      livePageAfter,
      autoRefreshUi,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshotPath, autoRefreshUi }, null, 2));
  } catch (error) {
    const report = {
      ok: false,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      dataSourcePath,
      reportPath,
      beforeRefresh,
      afterRefresh,
      autoRefreshFetch,
      livePageBefore,
      livePageAfter,
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
