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
const defaultReportPath = path.join(buildDir, 'react-branches-smoke-report.json');
const archiveRequested = process.env.REACT_BRANCHES_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_BRANCHES_REPORT_DIR || path.join(repoRoot, 'reports', 'react-branches'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-branches-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-branches-smoke-1280x760.png');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assistant(id, text) {
  return { id, role: 'assistant', status: 'done', text, progress: [], operations: [], sources: [], approvalState: 'idle' };
}

function seededConversations() {
  const common = [
    { id: 'u-root', role: 'user', text: 'COMMON_NODE_MARKER 共同节点：准备季度报告' },
    assistant('a-root', 'COMMON_ASSISTANT_MARKER 共同上下文：先确认受众和摘要结构。'),
  ];
  const mainMessages = [
    ...common,
    { id: 'u-main', role: 'user', text: 'MAIN_ONLY_MARKER 主线继续：预算版本' },
    assistant('a-main', 'MAIN_ASSISTANT_MARKER 主线回复：使用预算版叙事。'),
  ];
  const branchMessages = [
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

function findBrowser() {
  const candidates = process.platform === 'win32'
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
          response.on('data', (chunk) => { body += chunk; });
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
    this.handlers = new Map();
  }

  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening DevTools websocket')), 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Failed opening DevTools websocket'));
      }, { once: true });
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
      if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) handler(message.params || {});
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

async function evaluate(sendPage, expression, awaitPromise = true) {
  const result = await sendPage('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
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
  let baseUrl = null;
  let browser = null;
  let client = null;
  let userDataDir = null;
  const stderr = [];

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
        localStorage.setItem('kcw.conversations.v1', ${JSON.stringify(JSON.stringify(seededConversations()))});
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const ready = document.querySelector('.conv-branch-select') &&
            document.body.innerText.includes('MAIN_ONLY_MARKER') &&
            document.body.innerText.includes(${JSON.stringify(workspace)});
          if (ready) resolve(true);
          else if (Date.now() > deadline) reject(new Error('React branch smoke shell did not become ready'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    const initialMain = await evaluate(
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
    );

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

    const branchView = await evaluate(
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
    );

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

    const returnedMain = await evaluate(
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
    );

    assert(initialMain.selected === 'main', 'seeded conversation did not start on main branch');
    assert(initialMain.optionLabels.includes('主线') && initialMain.optionLabels.includes('分支 1'), 'branch options were not rendered');
    assert(initialMain.hasMain && !initialMain.hasBranch, 'initial timeline did not show only main branch messages');
    assert(branchView.meta.includes('共同上下文') && branchView.meta.includes('分支差异'), 'branch diff summary was not visible after switching');
    assert(returnedMain.meta.includes('4 条消息'), 'main branch metadata was not restored after returning');

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
