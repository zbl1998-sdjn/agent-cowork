import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function findBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function getJson(url, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`${url} returned ${response.statusCode}: ${body}`));
              return;
            }
            resolve(JSON.parse(body));
          });
        });
        request.on('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error(`Timed out fetching ${url}`)));
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening DevTools websocket')), 5000);
      this.socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('Failed opening DevTools websocket'));
        },
        { once: true },
      );
    });

    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
        else resolve(message.result || {});
        return;
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(sendPage, expression, awaitPromise = true, contextId = undefined) {
  const result = await sendPage('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    ...(contextId ? { contextId } : {}),
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(detail);
  }
  return result.result?.value;
}

async function bind(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
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
  let baseUrl = null;
  let browser = null;
  let client = null;
  let userDataDir = null;
  let beforeRefresh = '';
  let afterRefresh = '';
  let autoRefreshFetch = null;
  let livePageBefore = '';
  let livePageAfter = '';
  const stderr = [];

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

    const version = await getJson(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sendPage = (method, params = {}) => client.send(method, params, sessionId);

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
          const workspaceReady = document.body.innerText.includes(${JSON.stringify(workspace)});
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

    const initialFrame = await evaluate(
      sendPage,
      `(() => {
        const frame = document.querySelector('.viz-frame');
        const srcdoc = frame?.getAttribute('srcdoc') || '';
        const dataUrl = srcdoc.match(/var DATA_URL = "([^"]+)"/)?.[1] || '';
        return { srcdoc, dataUrl };
      })()`,
    );
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

    autoRefreshFetch = await evaluate(
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
    );

    const autoRefreshUi = await evaluate(
      sendPage,
      `(() => ({
        label: document.querySelector('.live-artifact-auto')?.innerText || '',
        status: document.querySelector('.live-artifact-view .panel-note')?.innerText || '',
        interval: document.querySelector('input[aria-label="自动刷新间隔秒"]')?.value || ''
      }))()`,
    );
    assert(autoRefreshUi.label.includes('自动刷新 1s'), `auto refresh label did not update: ${autoRefreshUi.label}`);
    assert(autoRefreshUi.interval === '1', `auto refresh interval did not remain at 1: ${autoRefreshUi.interval}`);

    const liveId = initialFrame.dataUrl.split('/').pop();
    assert(liveId, `could not derive live artifact id from ${initialFrame.dataUrl}`);
    const liveUrl = `${baseUrl}/api/artifacts/live/${encodeURIComponent(liveId)}`;
    const { targetId: liveTargetId } = await client.send('Target.createTarget', { url: liveUrl });
    const { sessionId: liveSessionId } = await client.send('Target.attachToTarget', { targetId: liveTargetId, flatten: true });
    const sendLivePage = (method, params = {}) => client.send(method, params, liveSessionId);
    await sendLivePage('Page.enable');
    await sendLivePage('Runtime.enable');
    livePageBefore = await evaluate(
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
    );
    await evaluate(
      sendLivePage,
      `(() => {
        const button = document.getElementById('refresh');
        if (!button) throw new Error('standalone live artifact refresh button missing');
        button.click();
        return true;
      })()`,
    );
    livePageAfter = await evaluate(
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
    );
    afterRefresh = livePageAfter;

    const screenshot = await sendPage('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
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
      error: error.stack || error.message,
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
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
    error: error.stack || error.message,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
