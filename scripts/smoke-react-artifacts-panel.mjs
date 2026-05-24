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
const defaultReportPath = path.join(buildDir, 'react-artifacts-smoke-report.json');
const archiveRequested = process.env.REACT_ARTIFACTS_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_ARTIFACTS_REPORT_DIR || path.join(repoRoot, 'reports', 'react-artifacts'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-artifacts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-artifacts-smoke-1280x760.png');

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
    this.handlers = new Map();
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
  assert(browserPath, 'No Edge or Chrome executable was found for React artifacts smoke');

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-artifacts-'));
  const artifactsDir = path.join(workspace, '.AgentCowork', 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const originalArtifact = path.join(artifactsDir, 'report.md');
  const renamedArtifact = path.join(artifactsDir, 'report-final.md');
  fs.writeFileSync(originalArtifact, '# React Artifact Smoke\n\nArtifact panel should list and rename this file.\n', 'utf8');

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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-artifacts-profile-'));
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
        localStorage.setItem('kcw.conversations.v1', JSON.stringify([{ id: 'artifact-smoke-conv', title: '03-B2 artifact smoke', messages: [] }]));
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function tick() {
          const headerReady = [...document.querySelectorAll('button')].some((button) => button.innerText.trim() === '产物');
          const workspaceReady = document.body.innerText.includes(${JSON.stringify(workspace)});
          if (headerReady && workspaceReady) resolve(true);
          else if (Date.now() > deadline) reject(new Error('React shell did not become ready for artifact smoke'));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '产物');
        if (!button) throw new Error('artifact panel button not found');
        button.click();
        return true;
      })()`,
    );

    const beforeRename = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const card = [...document.querySelectorAll('.artifact-panel-card')].find((item) => item.innerText.includes('report.md'));
          return {
            hasPanel: Boolean(document.querySelector('.side-panel h2')?.innerText.includes('产物')),
            hasCard: Boolean(card),
            cardText: card?.innerText || '',
            cardCount: document.querySelectorAll('.artifact-panel-card').length
          };
        }
        function tick() {
          const current = snapshot();
          if (current.hasPanel && current.hasCard) resolve(current);
          else if (Date.now() > deadline) reject(new Error('artifact card did not render: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const card = [...document.querySelectorAll('.artifact-panel-card')].find((item) => item.innerText.includes('report.md'));
        if (!card) throw new Error('artifact card missing before rename');
        const renameButton = [...card.querySelectorAll('button')].find((button) => button.innerText.trim() === '重命名');
        if (!renameButton) throw new Error('rename button missing');
        renameButton.click();
        return true;
      })()`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const card = [...document.querySelectorAll('.artifact-panel-card')].find((item) => item.innerText.includes('report.md'));
        const input = card?.querySelector('input');
        if (!input) throw new Error('rename input missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setValue.call(input, 'report-final.md');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'report-final.md' }));
        const saveButton = [...card.querySelectorAll('button')].find((button) => button.innerText.trim() === '保存');
        if (!saveButton) throw new Error('save button missing');
        saveButton.click();
        return true;
      })()`,
    );

    const afterRename = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const text = document.body.innerText;
          const card = [...document.querySelectorAll('.artifact-panel-card')].find((item) => item.innerText.includes('report-final.md'));
          return {
            hasRenamedCard: Boolean(card),
            oldNameVisible: text.includes('report.md'),
            newNameVisible: text.includes('report-final.md'),
            cardText: card?.innerText || '',
            errorText: document.querySelector('.panel-result')?.innerText || ''
          };
        }
        function tick() {
          const current = snapshot();
          if (current.hasRenamedCard && !current.errorText) resolve(current);
          else if (Date.now() > deadline) reject(new Error('artifact rename did not appear in UI: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    assert(beforeRename.hasCard, 'artifact panel did not list the seeded artifact');
    assert(afterRename.hasRenamedCard, 'artifact panel did not show the renamed artifact');
    assert(fs.existsSync(renamedArtifact), 'renamed artifact does not exist on disk');
    assert(!fs.existsSync(originalArtifact), 'original artifact still exists after rename');

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
      originalArtifact,
      renamedArtifact,
      beforeRename,
      afterRename,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshotPath, beforeRename, afterRename }, null, 2));
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
