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
const defaultReportPath = path.join(buildDir, 'react-scroll-smoke-report.json');
const archiveRequested = process.env.REACT_SCROLL_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_SCROLL_REPORT_DIR || path.join(repoRoot, 'reports', 'react-scroll'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-scroll-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-scroll-smoke-1280x760.png');

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

function seededConversations() {
  const messages = [];
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

  return async ({ onContent }) => {
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
    kimiChatRunner: async () => ({ ok: true, text: 'dry-run' }),
    kimiPlanRunner: async () => ({ ok: true, text: 'dry-run' }),
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

    const initial = await evaluate(
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
    );

    const scrolledAway = await evaluate(
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
    );

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

    const afterStream = await evaluate(
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
    );

    await evaluate(
      sendPage,
      `(() => {
        document.querySelector('.jump-to-bottom')?.click();
        return true;
      })()`,
    );

    const afterJump = await evaluate(
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
    );

    assert(initial.bubbleCount >= 60, 'seeded conversation did not render enough timeline messages');
    assert(scrolledAway.distanceFromBottom > 300, 'manual scroll did not leave the bottom');
    assert(afterStream.hasStartMarker && afterStream.hasDoneMarker, 'streamed assistant text was not rendered');
    assert(afterStream.distanceFromBottom > 300, 'timeline jumped back to bottom while user was reading history');
    assert(afterStream.jumpVisible, 'jump-to-bottom button did not appear for new content away from bottom');
    assert(afterJump.distanceFromBottom <= 48, 'jump-to-bottom button did not scroll near bottom');
    assert(!afterJump.jumpVisible, 'jump-to-bottom button stayed visible after returning to bottom');

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
