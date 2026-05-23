import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const reportPath = path.join(buildDir, 'rendered-ui-smoke-report.json');
const screenshotPath = path.join(buildDir, 'rendered-ui-smoke-1536x900.png');

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
        if (message.error) {
          reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
        } else {
          resolve(message.result || {});
        }
        return;
      }
      if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) {
          handler(message.params || {});
        }
      }
    });
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
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
    kimiPlanRunner: async ({ prompt, summary, mode }) => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-test',
      text: `测试 Kimi 计划：${mode} / ${prompt} / ${summary}`,
      durationMs: 16,
    }),
    kimiChatRunner: async ({ prompt, summary }) => ({
      ok: true,
      provider: 'kimi-api',
      model: 'kimi-test',
      text: `测试 Kimi 对话：${prompt} / ${summary}`,
      durationMs: 12,
    }),
  });
  await new Promise((resolve, reject) => {
    host.once('error', reject);
    host.listen(0, '127.0.0.1', resolve);
  });

  const baseUrl = `http://127.0.0.1:${host.address().port}`;
  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-chrome-profile-'));
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
  browser.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
  });

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

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(
      { send: sendPage },
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
      { send: sendPage },
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
    );
    assert(desktopLayout.title === 'Agent Cowork', 'rendered page title mismatch');
    assert(desktopLayout.activeMode === '对话', 'rendered page should default to 对话 mode');
    assert(desktopLayout.hasGreeting && desktopLayout.hasModeTabs && desktopLayout.hasSidebarActions, 'rendered page missing Image #1 functional shell');
    assert(desktopLayout.hasCowork && desktopLayout.hasQuickActions, 'rendered page missing Agent cowork quick actions');
    assert(desktopLayout.hasInteractionStream, 'rendered page missing cowork interaction stream');
    assert(desktopLayout.hasRunCards, 'rendered page missing task card panel');
    assert(!desktopLayout.hasFrameworkOverlay, 'rendered page appears to show a framework error overlay');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'desktop layout has horizontal overflow');

    const screenshot = await sendPage('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      { send: sendPage },
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
    const compactLayout = await evaluate(
      { send: sendPage },
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
    );
    assert(compactLayout.issues.length === 0, `compact layout issues: ${compactLayout.issues.join(', ')}`);
    assert(compactLayout.scroll.width <= compactLayout.scroll.clientWidth + 1, 'compact layout has horizontal overflow');
    assert(compactLayout.scroll.height <= compactLayout.scroll.clientHeight + 1, 'compact layout has vertical overflow');

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const interaction = await evaluate(
      { send: sendPage },
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
    );
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
    const artifactContent = fs.readFileSync(path.join(artifactsDir, artifacts[0]), 'utf8');
    assert(artifactContent.includes('来源摘要'), 'artifact missing source summary');
    assert(fs.readFileSync(auditPath, 'utf8').includes('"action":"write"'), 'audit log missing browser write action');

    const uploadAndChat = await evaluate(
      { send: sendPage },
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
    );
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
    const uploadedFiles = fs.existsSync(uploadRoot)
      ? fs.readdirSync(uploadRoot, { recursive: true }).filter((name) => String(name).endsWith('invoice-ui-smoke.txt'))
      : [];
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
      error: error.stack || error.message,
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    client?.close();
    browser.kill();
    await new Promise((resolve) => host.close(resolve));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only; the report keeps the workspace artifacts for inspection.
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
