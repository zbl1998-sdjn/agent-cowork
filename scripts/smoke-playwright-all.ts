// Playwright-style full UI smoke(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:启动真实 host + React UI dist,用 Edge/Chrome 真实验证模板上传、拖拽批量上传、
// 本地模型选择、当前项目可视化和移动端无横向溢出。报告/截图写入 output/playwright。
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
const uiDistRoot = path.join(repoRoot, 'apps', 'windows-client', 'ui-dist');
const outputRoot = path.join(repoRoot, 'output', 'playwright');
const reportPath = path.join(outputRoot, 'agent-cowork-all-smoke-report.json');
const home1366ScreenshotPath = path.join(outputRoot, 'agent-cowork-beginner-home-1366.png');
const home1536ScreenshotPath = path.join(outputRoot, 'agent-cowork-beginner-home-1536.png');
const composerAdvancedMobileScreenshotPath = path.join(outputRoot, 'agent-cowork-composer-advanced-mobile.png');
const desktopScreenshotPath = path.join(outputRoot, 'agent-cowork-all-desktop.png');
const mobileScreenshotPath = path.join(outputRoot, 'agent-cowork-all-mobile.png');
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const OLLAMA_MODEL = 'qwen2.5:0.5b';

type SmokeSnapshot = {
  templateStatus: string;
  templateError: string;
  templateSuggestion: string;
  attachmentSummary: string;
  attachmentNames: string[];
  provider: string;
  model: string;
  modelOptions: string[];
  vizText: string;
  hasVizFrame: boolean;
  securityText: string;
  assistantText: string;
  scrollWidth: number;
  clientWidth: number;
};

type BeginnerHomeSnapshot = {
  text: string;
  taskCount: number;
  scrollWidth: number;
  clientWidth: number;
};

type AttachmentUiSnapshot = {
  summary: string;
  names: string[];
};

function listFilesRecursive(root: string, predicate: (name: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...listFilesRecursive(full, predicate));
    else if (entry.isFile() && predicate(entry.name)) found.push(full);
  }
  return found;
}

function snapshotFromPage(value: unknown): SmokeSnapshot {
  if (!isRecord(value)) throw new TypeError('smoke snapshot must be an object');
  return {
    templateStatus: typeof value.templateStatus === 'string' ? value.templateStatus : '',
    templateError: typeof value.templateError === 'string' ? value.templateError : '',
    templateSuggestion: typeof value.templateSuggestion === 'string' ? value.templateSuggestion : '',
    attachmentSummary: typeof value.attachmentSummary === 'string' ? value.attachmentSummary : '',
    attachmentNames: Array.isArray(value.attachmentNames) ? value.attachmentNames.filter((item): item is string => typeof item === 'string') : [],
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    modelOptions: Array.isArray(value.modelOptions) ? value.modelOptions.filter((item): item is string => typeof item === 'string') : [],
    vizText: typeof value.vizText === 'string' ? value.vizText : '',
    hasVizFrame: value.hasVizFrame === true,
    securityText: typeof value.securityText === 'string' ? value.securityText : '',
    assistantText: typeof value.assistantText === 'string' ? value.assistantText : '',
    scrollWidth: typeof value.scrollWidth === 'number' ? value.scrollWidth : 0,
    clientWidth: typeof value.clientWidth === 'number' ? value.clientWidth : 0,
  };
}

async function installedOllamaModels(): Promise<string[]> {
  const response = await fetch('http://127.0.0.1:11434/api/tags');
  assert(response.ok, `Ollama tags endpoint failed with status ${response.status}`);
  const payload = await response.json() as { models?: Array<{ name?: unknown }> };
  return Array.isArray(payload.models) ? payload.models.map((item) => String(item.name || '')).filter(Boolean) : [];
}

function readEgressRecords(workspace: string): Array<Record<string, unknown>> {
  const auditFile = path.join(workspace, '.AgentCowork', 'security', 'egress-audit.jsonl');
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf8')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function attachmentUiSnapshot(value: unknown): AttachmentUiSnapshot {
  if (!isRecord(value)) throw new TypeError('attachment UI snapshot must be an object');
  return {
    summary: typeof value.summary === 'string' ? value.summary : '',
    names: Array.isArray(value.names) ? value.names.filter((item): item is string => typeof item === 'string') : [],
  };
}

function beginnerHomeSnapshot(value: unknown): BeginnerHomeSnapshot {
  if (!isRecord(value)) throw new TypeError('beginner home snapshot must be an object');
  return {
    text: typeof value.text === 'string' ? value.text : '',
    taskCount: typeof value.taskCount === 'number' ? value.taskCount : 0,
    scrollWidth: typeof value.scrollWidth === 'number' ? value.scrollWidth : 0,
    clientWidth: typeof value.clientWidth === 'number' ? value.clientWidth : 0,
  };
}

async function waitForPage(sendPage: SendPage, predicateSource: string, message: string, timeoutMs = 10000): Promise<void> {
  await evaluate(
    sendPage,
    `new Promise((resolve, reject) => {
      const deadline = Date.now() + ${timeoutMs};
      function tick() {
        try {
          if ((${predicateSource})()) resolve(true);
          else if (Date.now() > deadline) reject(new Error(${JSON.stringify(message)}));
          else setTimeout(tick, 50);
        } catch (error) {
          reject(error);
        }
      }
      tick();
    })`,
  );
}

async function waitForFiles(root: string, names: string[], timeoutMs = 10000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const files = listFilesRecursive(root, (name) => names.includes(name));
    if (names.every((name) => files.some((file) => path.basename(file) === name))) return files;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`uploaded files not found under ${root}`);
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  assert(fs.existsSync(path.join(uiDistRoot, 'index.html')), 'React UI dist is missing; run npm run build:ui first');
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for Playwright smoke');
  const ollamaModels = await installedOllamaModels();
  assert(ollamaModels.includes(OLLAMA_MODEL), `Ollama model ${OLLAMA_MODEL} is not installed`);

  const workspace = fs.mkdtempSync(path.join(outputRoot, 'workspace-'));
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'seed-notes.txt'), 'Agent Cowork project seed note\n', 'utf8');

  const host = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    uiDistRoot,
    securityMode: 'local_strict',
    kimiProvider: 'ollama',
    kimiBaseUrl: OLLAMA_BASE_URL,
    kimiModel: OLLAMA_MODEL,
  });
  const startedAt = Date.now();
  let baseUrl = '';
  let browser: ChildProcessLike | null = null;
  let client: CdpClient | null = null;
  let userDataDir = '';
  const stderr: string[] = [];
  let snapshot: SmokeSnapshot | null = null;
  let templateSuggestionText = '';
  let templateErrorText = '';
  let modelProviderSnapshot = '';
  let modelValueSnapshot = '';
  let modelOptionsSnapshot: string[] = [];
  let assistantTextSnapshot = '';
  let attachmentUi: AttachmentUiSnapshot | null = null;
  let beginnerHome: BeginnerHomeSnapshot | null = null;
  let uploadedFiles: string[] = [];
  let egressRecords: Array<Record<string, unknown>> = [];
  let securityStatus: Record<string, unknown> | null = null;

  try {
    baseUrl = await bind(host);
    const debugPort = await getFreePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-playwright-profile-'));
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
    browser.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

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
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sendPage('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        localStorage.setItem('kcw.guest', '1');
        localStorage.setItem('kcw.onboardingDone', '1');
        localStorage.setItem('kcw.conversations.v1', JSON.stringify([{ id: 'playwright-all', title: 'Playwright all', messages: [] }]));
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await waitForPage(
      sendPage,
      `() => document.querySelector('.app-header') && document.querySelector('.security-status-bar') && document.querySelector('.template-upload-input') && document.querySelector('.provider-select option[value="ollama"]')`,
      'React shell did not become ready for full Playwright smoke',
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.security-status-bar')?.innerText.includes('外发 0 B')`,
      'security status bar did not report zero external egress',
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.beginner-home')?.innerText.includes('今天想完成什么')`,
      'beginner home did not render',
    );
    beginnerHome = beginnerHomeSnapshot(await evaluate(
      sendPage,
      `(() => ({
        text: document.querySelector('.beginner-home')?.innerText || '',
        taskCount: document.querySelectorAll('.beginner-task').length,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))()`,
    ));
    assert(beginnerHome.text.includes('Word'), 'beginner home missing Word format');
    assert(beginnerHome.text.includes('Excel'), 'beginner home missing Excel format');
    assert(beginnerHome.text.includes('PPT'), 'beginner home missing PPT format');
    assert(beginnerHome.text.includes('PDF'), 'beginner home missing PDF format');
    assert(beginnerHome.text.includes('拖入'), 'beginner home missing drag upload copy');
    assert(beginnerHome.taskCount >= 7, 'beginner home daily task count is too low');
    assert(!/(MCP|Provider|Model Router|API Key|Token|JSON|Shell|Workspace Root|Vector Index|Prompt Cache)/.test(beginnerHome.text), 'beginner home leaked expert terms');
    assert(beginnerHome.scrollWidth <= beginnerHome.clientWidth + 1, '1366 beginner home has horizontal overflow');
    const home1366Shot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(home1366ScreenshotPath, Buffer.from(home1366Shot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForPage(
      sendPage,
      `() => document.querySelector('.beginner-home') && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`,
      '1536 beginner home has horizontal overflow',
    );
    const home1536Shot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(home1536ScreenshotPath, Buffer.from(home1536Shot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await waitForPage(
      sendPage,
      `() => {
        const footer = document.querySelector('.composer-footer');
        const left = document.querySelector('.composer-footer-left');
        const right = document.querySelector('.composer-footer-right');
        const provider = document.querySelector('.provider-select');
        const model = document.querySelector('.model-input');
        const thinking = document.querySelector('.thinking-select');
        if (!footer || !left || !right || !provider || !model || !thinking) return false;
        const viewportWidth = document.documentElement.clientWidth;
        const footerRect = footer.getBoundingClientRect();
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const providerRect = provider.getBoundingClientRect();
        const modelRect = model.getBoundingClientRect();
        const thinkingRect = thinking.getBoundingClientRect();
        const visibleControls = [providerRect, modelRect, thinkingRect].every((rect) => rect.width >= 48 && rect.left >= 0 && rect.right <= viewportWidth + 1);
        return document.documentElement.scrollWidth <= viewportWidth + 1
          && footerRect.left >= 0
          && footerRect.right <= viewportWidth + 1
          && leftRect.width > 80
          && rightRect.width > 160
          && visibleControls;
      }`,
      'mobile composer footer controls overflow horizontally',
    );
    const composerAdvancedShot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(composerAdvancedMobileScreenshotPath, Buffer.from(composerAdvancedShot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 920,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await waitForPage(
      sendPage,
      `() => document.querySelector('.template-upload-bar .template-upload-input')`,
      'template upload bar did not render',
    );

    const strictTemplateBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: 'strict-browser-template',
      name: '严格浏览器模板',
      description: '浏览器导入的严格模板',
      prompt: '按模板输出',
      output: 'Markdown',
      riskLevel: 'safe-write',
      requiresSources: false,
      redacted: true,
      format: { kind: 'markdown', body: '# {{recipe.name}}' },
      steps: [],
      artifacts: [],
    }), 'utf8').toString('base64');
    await evaluate(
      sendPage,
      `(() => {
        const input = document.querySelector('.template-upload-input');
        if (!input) throw new Error('template upload input missing');
        const fileBytes = Uint8Array.from(atob('${strictTemplateBytes}'), (char) => char.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([fileBytes], 'strict-browser-template.json', { type: 'application/json' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.template-upload-status')?.innerText.includes('已导入 1 个模板')`,
      'valid template upload did not complete',
    );

    const invalidTemplateBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      id: 'bad-browser-template',
      name: '坏模板',
      description: '带额外字段',
      prompt: 'x',
      output: 'Markdown',
      riskLevel: 'safe-write',
      requiresSources: false,
      redacted: true,
      format: { kind: 'markdown', body: '# Bad' },
      steps: [],
      artifacts: [],
      extra: 'blocked',
    }), 'utf8').toString('base64');
    await evaluate(
      sendPage,
      `(() => {
        const input = document.querySelector('.template-upload-input');
        if (!input) throw new Error('template upload input missing');
        const fileBytes = Uint8Array.from(atob('${invalidTemplateBytes}'), (char) => char.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([fileBytes], 'bad-browser-template.json', { type: 'application/json' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.template-upload-status.is-error')?.innerText.length > 0`,
      'invalid template upload was not rejected visibly',
    );
    templateErrorText = String(await evaluate(
      sendPage,
      `document.querySelector('.template-upload-status.is-error')?.innerText || ''`,
    ));

    await evaluate(
      sendPage,
      `(() => {
        const textarea = document.querySelector('.composer textarea');
        if (!textarea) throw new Error('composer textarea missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setValue.call(textarea, '/严格');
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '/严格' }));
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.composer-popover')?.innerText.includes('严格浏览器模板')`,
      'imported template did not appear in slash suggestions',
    );
    templateSuggestionText = String(await evaluate(
      sendPage,
      `document.querySelector('.composer-popover')?.innerText || ''`,
    ));

    await evaluate(
      sendPage,
      `(() => {
        const provider = document.querySelector('.provider-select');
        const model = document.querySelector('.model-input');
        if (!provider) throw new Error('provider select missing');
        if (!model) throw new Error('model input missing');
        const option = provider.querySelector('option[value="ollama"]');
        if (!option) throw new Error('ollama provider option missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setValue.call(provider, 'ollama');
        option.selected = true;
        provider.dispatchEvent(new Event('input', { bubbles: true }));
        provider.dispatchEvent(new Event('change', { bubbles: true }));
        const setModelValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setModelValue.call(model, ${JSON.stringify(OLLAMA_MODEL)});
        model.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(OLLAMA_MODEL)} }));
        model.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.provider-select')?.value === 'ollama' && document.querySelector('.model-input')?.value === ${JSON.stringify(OLLAMA_MODEL)}`,
      'Ollama provider did not become selected',
    );
    const modelControlValue = await evaluate(
      sendPage,
      `(() => ({
        provider: document.querySelector('.provider-select')?.value || '',
        model: document.querySelector('.model-input')?.value || ''
      }))()`,
    );
    assert(isRecord(modelControlValue), 'model control snapshot must be an object');
    modelProviderSnapshot = typeof modelControlValue.provider === 'string' ? modelControlValue.provider : '';
    modelValueSnapshot = typeof modelControlValue.model === 'string' ? modelControlValue.model : '';
    await evaluate(
      sendPage,
      `(() => {
        const input = document.querySelector('.model-input');
        if (!input) throw new Error('model input missing for model options snapshot');
        input.scrollIntoView({ block: 'center', inline: 'nearest' });
        input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        input.focus();
        return document.activeElement === input;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.model-menu') && [...document.querySelectorAll('.model-opt-id')].length > 0`,
      'model picker menu did not open for composer snapshot',
    );
    const modelOptionsValue = await evaluate(
      sendPage,
      `[...document.querySelectorAll('.model-opt-id')].map((node) => node.textContent || '')`,
    );
    assert(Array.isArray(modelOptionsValue), 'model options snapshot must be an array');
    modelOptionsSnapshot = modelOptionsValue.filter((item): item is string => typeof item === 'string' && item.length > 0);
    await evaluate(sendPage, `document.querySelector('.model-input')?.blur()`);

    await evaluate(
      sendPage,
      `(() => {
        const composer = document.querySelector('.composer');
        if (!composer) throw new Error('composer missing');
        const dt = new DataTransfer();
        dt.items.add(new File(['alpha upload smoke'], 'drag-alpha.txt', { type: 'text/plain', lastModified: 1 }));
        dt.items.add(new File(['beta upload smoke'], 'drag-beta.txt', { type: 'text/plain', lastModified: 2 }));
        composer.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        composer.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.attachment-summary')?.innerText.includes('已选 2 个文件') && document.body.innerText.includes('drag-alpha.txt') && document.body.innerText.includes('drag-beta.txt')`,
      'drag/drop batch attachments did not render',
    );
    attachmentUi = attachmentUiSnapshot(await evaluate(
      sendPage,
      `(() => ({
        summary: document.querySelector('.attachment-summary')?.innerText || '',
        names: [...document.querySelectorAll('.attachment-name')].map((node) => node.innerText)
      }))()`,
    ));

    await evaluate(
      sendPage,
      `(() => {
        const textarea = document.querySelector('.composer textarea');
        const send = document.querySelector('.send-button');
        if (!textarea || !send) throw new Error('send controls missing');
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setValue.call(textarea, '请读取刚才拖入的两个文件并生成结果');
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'upload' }));
        send.click();
        return true;
      })()`,
    );
    uploadedFiles = await waitForFiles(path.join(workspace, 'Agent_Cowork上传'), ['drag-alpha.txt', 'drag-beta.txt']);
    await waitForPage(
      sendPage,
      `() => [...document.querySelectorAll('.bubble-assistant .message-text')].some((node) => node.innerText.trim().length > 0)`,
      'Ollama model did not return an assistant message',
      120000,
    );
    assistantTextSnapshot = String(await evaluate(
      sendPage,
      `[...document.querySelectorAll('.bubble-assistant .message-text')].map((node) => node.innerText).join(String.fromCharCode(10))`,
    ));
    egressRecords = readEgressRecords(workspace);
    const lastModelEgress = [...egressRecords].reverse().find((record) => record.kind === 'model_inference');
    assert(lastModelEgress?.provider === 'ollama', `expected Ollama egress record, got ${String(lastModelEgress?.provider || '')}`);
    assert(lastModelEgress?.model === OLLAMA_MODEL, `expected ${OLLAMA_MODEL} egress record, got ${String(lastModelEgress?.model || '')}`);
    securityStatus = await getJson<Record<string, unknown>>(`${baseUrl}/api/security/status`, 10000);

    await evaluate(
      sendPage,
      `(() => {
        const summary = document.querySelector('.header-more summary');
        if (!summary) throw new Error('header more summary missing');
        summary.click();
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.header-more')?.hasAttribute('open')`,
      'header more menu did not open',
    );
    await evaluate(
      sendPage,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '可视化');
        if (!button) throw new Error('visualization panel button missing');
        button.click();
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.project-viz-overview')?.innerText.includes('Agent Cowork 项目视图')`,
      'project visualization panel did not render',
    );
    await waitForPage(
      sendPage,
      `() => {
        const button = [...document.querySelectorAll('.project-viz-actions button')].find((item) => item.innerText.includes('渲染当前项目活页'));
        return button && !button.disabled;
      }`,
      'project render button did not become enabled',
    );
    await evaluate(
      sendPage,
      `(() => {
        const button = [...document.querySelectorAll('.project-viz-actions button')].find((item) => item.innerText.includes('渲染当前项目活页'));
        if (!button) throw new Error('render current project button missing');
        button.click();
        return true;
      })()`,
    );
    await waitForPage(
      sendPage,
      `() => document.querySelector('.viz-frame') && document.querySelector('.live-artifact-view')`,
      'project live artifact did not render',
    );

    const desktopShot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(desktopScreenshotPath, Buffer.from(desktopShot.data, 'base64'));

    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await waitForPage(
      sendPage,
      `() => document.querySelector('.project-viz-overview') && document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`,
      'mobile project visualization has horizontal overflow',
    );
    const mobileShot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(mobileScreenshotPath, Buffer.from(mobileShot.data, 'base64'));


    snapshot = snapshotFromPage(await evaluate(
      sendPage,
      `(() => ({
        templateStatus: document.querySelector('.template-upload-status')?.innerText || '',
        templateError: document.querySelector('.template-upload-status.is-error')?.innerText || '',
        templateSuggestion: document.querySelector('.composer-popover')?.innerText || '',
        attachmentSummary: document.querySelector('.attachment-summary')?.innerText || '',
        attachmentNames: [...document.querySelectorAll('.attachment-name')].map((node) => node.innerText),
        provider: document.querySelector('.provider-select')?.value || '',
        model: document.querySelector('.model-input')?.value || '',
        modelOptions: [...document.querySelectorAll('.model-opt-id')].map((node) => node.textContent || ''),
        vizText: document.querySelector('.project-viz-overview')?.innerText || '',
        hasVizFrame: Boolean(document.querySelector('.viz-frame')),
        securityText: document.querySelector('.security-status-bar')?.innerText || '',
        assistantText: [...document.querySelectorAll('.bubble-assistant .message-text')].map((node) => node.innerText).join('\\n'),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      }))()`,
    ));
    snapshot.templateError = templateErrorText || snapshot.templateError;
    snapshot.attachmentSummary = attachmentUi?.summary || snapshot.attachmentSummary;
    snapshot.attachmentNames = attachmentUi?.names || snapshot.attachmentNames;
    snapshot.provider = modelProviderSnapshot || snapshot.provider;
    snapshot.model = modelValueSnapshot || snapshot.model;
    snapshot.modelOptions = modelOptionsSnapshot.length ? modelOptionsSnapshot : snapshot.modelOptions;
    snapshot.assistantText = assistantTextSnapshot || snapshot.assistantText;
    assert(snapshot.templateError.length > 0, 'invalid template error was not retained in UI state');
    assert(templateSuggestionText.includes('严格浏览器模板'), 'imported template missing from suggestion snapshot');
    assert(attachmentUi, 'attachment UI snapshot missing');
    assert(attachmentUi.summary.includes('已选 2 个文件'), 'batch attachment summary missing');
    assert(attachmentUi.names.includes('drag-alpha.txt') && attachmentUi.names.includes('drag-beta.txt'), 'batch attachment names missing');
    assert(snapshot.provider === 'ollama', `expected ollama provider, got ${snapshot.provider}`);
    assert(snapshot.model === OLLAMA_MODEL, `expected ${OLLAMA_MODEL}, got ${snapshot.model}`);
    assert(snapshot.modelOptions.includes('qwen3'), 'Ollama qwen3 curated model missing');
    assert(snapshot.modelOptions.includes('qwen2.5:0.5b'), 'Ollama qwen2.5:0.5b curated fallback missing');
    assert(!snapshot.modelOptions.includes('deepseek-r1:7b'), 'Ollama stale R1 should not be a curated highlight');
    assert(snapshot.assistantText.trim().length > 0, 'Ollama assistant text missing');
    assert(snapshot.securityText.includes('外发 0 B'), 'security status did not show zero external egress');
    assert(snapshot.vizText.includes('Agent Cowork 项目视图'), 'project visualization snapshot missing project view');
    assert(snapshot.hasVizFrame, 'live artifact iframe missing');
    assert(snapshot.scrollWidth <= snapshot.clientWidth + 1, 'mobile layout has horizontal overflow');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      ollama: { baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, installedModels: ollamaModels },
      reportPath,
      screenshots: { desktopScreenshotPath, mobileScreenshotPath, composerAdvancedMobileScreenshotPath },
      beginnerScreenshots: { home1366ScreenshotPath, home1536ScreenshotPath },
      uploadedFiles,
      beginnerHome,
      templateSuggestionText,
      attachmentUi,
      snapshot,
      egressRecords,
      securityStatus,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshots: report.screenshots, uploadedFiles }, null, 2));
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
      uploadedFiles,
      beginnerHome,
      templateSuggestionText,
      attachmentUi,
      snapshot,
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
        /* best-effort profile cleanup */
      }
    }
  }
}

main().catch((error) => {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ ok: false, generatedAt: new Date().toISOString(), error: errorDetails(error) }, null, 2)}\n`, 'utf8');
  console.error(errorDetails(error));
  process.exit(1);
});
