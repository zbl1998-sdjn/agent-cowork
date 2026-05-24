import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const runtimeFile = path.join(buildDir, 'mvp-runtime.json');
const reportPath = path.join(buildDir, 'live-mvp-smoke-report.json');
const screenshotPath = path.join(buildDir, 'live-mvp-smoke-1536x900.png');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
      } else {
        resolve(message.result || {});
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    this.socket.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close() {
    this.socket?.close();
  }
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return result.result?.value;
}

function readRuntime() {
  assert(fs.existsSync(runtimeFile), `MVP runtime file is missing: ${runtimeFile}. Start the product with npm run start:mvp first.`);
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  assert(isPidAlive(runtime.pid), `MVP runtime pid is not alive: ${runtime.pid}`);
  assert(runtime.url && runtime.workspace, 'MVP runtime file is missing url or workspace');
  return runtime;
}

function listArtifacts(workspace) {
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
  const health = await getJson(`http://${runtime.host}:${runtime.port}/health`, 5000);
  assert(health.ok === true && health.service === 'agent-cowork-host', 'live MVP health check failed');

  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for live MVP smoke');

  const artifactBefore = new Set(listArtifacts(runtime.workspace));
  const auditPath = runtime.auditPath || path.join(runtime.workspace, '.AgentCowork', 'audit', 'host-events.jsonl');
  const auditSizeBefore = fs.existsSync(auditPath) ? fs.statSync(auditPath).size : 0;

  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-live-mvp-profile-'));
  const browser = spawn(
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
  const stderr = [];
  browser.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  let client;
  try {
    const version = await getJson(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    const sendPage = (method, params = {}) => client.send(method, params, sessionId);

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
      { send: sendPage },
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
    const auth = await evaluate(
      { send: sendPage },
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
    );
    await evaluate(
      { send: sendPage },
      `new Promise((resolve, reject) => {
        const expectedWorkspace = ${JSON.stringify(runtime.workspace)};
        const deadline = Date.now() + 8000;
        function tick() {
          const workspace = document.querySelector(".workspace-path")?.innerText.trim();
          const ready = Boolean(document.querySelector(".timeline") && document.querySelector(".composer textarea"));
          if (ready && workspace === expectedWorkspace) resolve(true);
          else if (Date.now() > deadline) reject(new Error("live MVP workspace did not synchronize with runtime"));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );
    await evaluate(
      { send: sendPage },
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

    const desktopLayout = await evaluate(
      { send: sendPage },
      `(() => {
        const scroll = {
          width: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          height: document.documentElement.scrollHeight,
          clientHeight: document.documentElement.clientHeight
        };
        const text = document.body.innerText;
        const buttons = [...document.querySelectorAll("button")].map((button) => button.innerText.trim()).filter(Boolean);
        return {
          title: document.title,
          location: window.location.href,
          workspace: document.querySelector(".workspace-path")?.innerText.trim(),
          user: document.querySelector(".header-user")?.innerText.trim(),
          hasShell: Boolean(document.querySelector(".app-shell")),
          hasTimeline: Boolean(document.querySelector(".timeline")),
          hasComposer: Boolean(document.querySelector(".composer textarea")),
          hasEmptyState: Boolean(document.querySelector(".empty-state")),
          hasCowork: text.includes("Agent Cowork"),
          hasConversationRail: Boolean(document.querySelector(".conversation-rail")),
          hasHeaderActions: ["工具", "可视化", "连接器", "产物", "定时任务", "记忆"].every((label) => buttons.includes(label)),
          hasQuickActions: document.querySelectorAll(".starter-chip").length >= 4 && text.includes("整理工作区"),
          scroll
        };
      })()`,
    );
    assert(desktopLayout.title === 'Agent Cowork', 'live MVP title mismatch');
    assert(desktopLayout.location.startsWith(runtime.url), 'live MVP did not load runtime URL');
    assert(desktopLayout.workspace === runtime.workspace, 'live MVP workspace does not match runtime workspace');
    assert(desktopLayout.hasShell && desktopLayout.hasTimeline && desktopLayout.hasComposer, 'live MVP missing React functional shell');
    assert(desktopLayout.hasConversationRail && desktopLayout.hasHeaderActions, 'live MVP missing navigation/actions');
    assert(desktopLayout.hasCowork && desktopLayout.hasQuickActions, 'live MVP missing starter actions');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'live MVP desktop layout has horizontal overflow');

    const screenshot = await sendPage('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const planTimeoutMs = runtime.kimiApiPlanEnabled ? 90_000 : 5000;
    const interaction = await evaluate(
      { send: sendPage },
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
    );
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
      error: error.stack || error.message,
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
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
  console.error(error.stack || error.message);
  process.exit(1);
});
