import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const resourcesDir = path.join(repoRoot, 'apps', 'windows-client', 'resources');
const indexPath = path.join(resourcesDir, 'index.html');
const reportPath = path.join(buildDir, 'windows-client-resource-smoke-report.json');
const screenshotPath = path.join(buildDir, 'windows-client-resource-smoke-1536x900.png');

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

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  assert(fs.existsSync(indexPath), `Windows client resource entry is missing: ${indexPath}`);
  assert(fs.existsSync(path.join(resourcesDir, 'app.css')), 'Windows client CSS resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app-composer-popover.js')), 'Windows client composer popover resource is missing');
  assert(fs.existsSync(path.join(resourcesDir, 'app.js')), 'Windows client JS resource is missing');

  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for Windows client resource smoke');

  const debugPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-windows-resource-profile-'));
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
      '--allow-file-access-from-files',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  const stderr = [];
  browser.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  let client;
  const resourceUrl = pathToFileURL(indexPath).href;
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
    await sendPage('Page.navigate', { url: resourceUrl });
    await evaluate(
      { send: sendPage },
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
        const state = window.kimiCowork || {};
        return {
          title: document.title,
          protocol: window.location.protocol,
          hostApi: state.hostApi,
          status: document.querySelector(".status-pill")?.innerText.trim(),
          activeMode: document.querySelector(".mode-tab.is-active")?.innerText.trim(),
          hasGreeting: text.includes("欢迎回来，Derrick"),
          hasCowork: text.includes("Kimi Cowork"),
          hasModeTabs: text.includes("对话") && text.includes("协作") && text.includes("代码"),
          hasSidebarActions: text.includes("新建会话") && text.includes("项目") && text.includes("产物") && text.includes("自定义"),
          hasQuickActions: text.includes("学习") && text.includes("写作") && text.includes("Kimi 推荐") && text.includes("上传文件夹"),
          hasInteractionStream: document.querySelector(".interaction-stream")?.textContent.includes("执行动态") === true,
          hasRunCards: document.querySelector(".run-history-panel")?.textContent.includes("任务卡片") === true,
          scroll
        };
      })()`,
    );
    assert(desktopLayout.title === 'Kimi Cowork', 'Windows resource title mismatch');
    assert(desktopLayout.protocol === 'file:', 'Windows resource smoke must load via file:// static resource mode');
    assert(desktopLayout.hostApi === false, 'Windows resource static preview should not call Host API');
    assert(desktopLayout.status === '静态预览', 'Windows resource did not enter static preview status');
    assert(desktopLayout.activeMode === '对话', 'Windows resource should default to 对话 mode');
    assert(desktopLayout.hasGreeting && desktopLayout.hasModeTabs && desktopLayout.hasSidebarActions, 'Windows resource missing Image #1 functional shell');
    assert(desktopLayout.hasCowork && desktopLayout.hasQuickActions, 'Windows resource missing expected Kimi controls');
    assert(desktopLayout.hasInteractionStream, 'Windows resource missing cowork interaction stream');
    assert(desktopLayout.hasRunCards, 'Windows resource missing task card panel');
    assert(desktopLayout.scroll.width <= desktopLayout.scroll.clientWidth + 1, 'Windows desktop resource layout has horizontal overflow');

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
    );
    assert(compactLayout.issues.length === 0, `Windows compact resource layout issues: ${compactLayout.issues.join(', ')}`);
    assert(compactLayout.scroll.width <= compactLayout.scroll.clientWidth + 1, 'Windows compact resource layout has horizontal overflow');
    assert(compactLayout.scroll.height <= compactLayout.scroll.clientHeight + 1, 'Windows compact resource layout has vertical overflow');

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
    );
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
