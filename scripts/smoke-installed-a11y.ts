// 安装版可访问性复扫(scripts · smoke·installed)
// ---------------------------------------------------------------------------
// 职责:启动真实安装版 Tauri/WebView2,通过 CDP 复扫屏幕阅读器可见结构、
//       live/status 区域、发送按钮对比度、各主视图可见文本对比度与布局溢出。
// 用法:node scripts/run-host-node.mjs scripts/smoke-installed-a11y.ts
// 产物:reports/windows-client-smoke/installed-a11y-*.json。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CdpClient,
  assert,
  errorDetails,
  evaluate,
  getFreePort,
  getJson,
  isRecord,
  type SendPage,
} from './browser-smoke-utils.js';

type DebugTarget = {
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type AxNode = {
  role?: { value?: string };
  name?: { value?: string };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};

type ContrastIssue = {
  selector: string;
  text: string;
  color: string;
  background: string;
  ratio: number;
  fontSize: number;
  fontWeight: string;
};

type ContrastSnapshot = {
  checked: number;
  issues: ContrastIssue[];
  sendButton: {
    text: string;
    color: string;
    background: string;
    ratio: number;
  } | null;
  liveRegions: Array<{ tag: string; role: string | null; ariaLive: string | null; label: string | null; text: string }>;
  timeline: {
    exists: boolean;
    role: string | null;
    ariaLive: string | null;
    ariaRelevant: string | null;
    label: string | null;
  };
  scroll: {
    width: number;
    clientWidth: number;
    height: number;
    clientHeight: number;
  };
};

type ViewSnapshot = {
  name: string;
  url: string;
  title: string;
  contrast: ContrastSnapshot;
};

type AxSummary = {
  nodeCount: number;
  statusLikeCount: number;
  logLikeCount: number;
  statusSamples: string[];
  logSamples: string[];
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportDir = path.join(repoRoot, 'reports', 'windows-client-smoke');
const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 17) + 'Z';
const reportPath = process.env.KCW_A11Y_REPORT_PATH || path.join(reportDir, `installed-a11y-${stamp}.json`);
const installedExe = process.env.KCW_INSTALLED_EXE || path.join(process.env.LOCALAPPDATA || '', 'Agent Cowork', 'agent-cowork-desktop.exe');
const workspace = process.env.KCW_A11Y_WORKSPACE || path.join(repoRoot, 'build', 'installed-a11y-workspace');
const panelLabels = ['工具', '可视化', '连接器', '产物', '项目', '定时任务', '记忆', '可观测'];
const settingsTabs = ['账户', '外观', '模型', '输入', 'API', '运行时', '更新', '健康检查'];

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readContrastSnapshot(value: unknown): ContrastSnapshot {
  if (!isRecord(value)) throw new TypeError('contrast snapshot must be an object');
  const sendButton = isRecord(value.sendButton)
    ? {
        text: typeof value.sendButton.text === 'string' ? value.sendButton.text : '',
        color: typeof value.sendButton.color === 'string' ? value.sendButton.color : '',
        background: typeof value.sendButton.background === 'string' ? value.sendButton.background : '',
        ratio: readNumber(value.sendButton.ratio),
      }
    : null;
  const timeline = isRecord(value.timeline) ? value.timeline : {};
  const scroll = isRecord(value.scroll) ? value.scroll : {};
  return {
    checked: readNumber(value.checked),
    issues: Array.isArray(value.issues) ? value.issues.filter(isContrastIssue) : [],
    sendButton,
    liveRegions: Array.isArray(value.liveRegions) ? value.liveRegions.filter(isLiveRegion) : [],
    timeline: {
      exists: timeline.exists === true,
      role: typeof timeline.role === 'string' ? timeline.role : null,
      ariaLive: typeof timeline.ariaLive === 'string' ? timeline.ariaLive : null,
      ariaRelevant: typeof timeline.ariaRelevant === 'string' ? timeline.ariaRelevant : null,
      label: typeof timeline.label === 'string' ? timeline.label : null,
    },
    scroll: {
      width: readNumber(scroll.width),
      clientWidth: readNumber(scroll.clientWidth),
      height: readNumber(scroll.height),
      clientHeight: readNumber(scroll.clientHeight),
    },
  };
}

function isContrastIssue(value: unknown): value is ContrastIssue {
  return isRecord(value)
    && typeof value.selector === 'string'
    && typeof value.text === 'string'
    && typeof value.color === 'string'
    && typeof value.background === 'string'
    && typeof value.ratio === 'number'
    && typeof value.fontSize === 'number'
    && typeof value.fontWeight === 'string';
}

function isLiveRegion(value: unknown): value is ContrastSnapshot['liveRegions'][number] {
  return isRecord(value)
    && typeof value.tag === 'string'
    && (typeof value.role === 'string' || value.role === null)
    && (typeof value.ariaLive === 'string' || value.ariaLive === null)
    && (typeof value.label === 'string' || value.label === null)
    && typeof value.text === 'string';
}

function ensureWorkspace(): void {
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'contracts', 'sample.txt'), 'Agent Cowork accessibility smoke workspace.\n', 'utf8');
}

async function waitForTarget(port: number, timeoutMs = 20000): Promise<DebugTarget> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await getJson<DebugTarget[]>(`http://127.0.0.1:${port}/json/list`, 1000);
      const target = targets.find((item) => item.webSocketDebuggerUrl && (
        item.url?.includes('tauri.localhost')
        || item.title?.includes('Agent Cowork')
        || item.type === 'page'
      ));
      if (target?.webSocketDebuggerUrl) return target;
    } catch (error) {
      lastError = errorDetails(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for installed WebView CDP target: ${lastError}`);
}

async function waitForShell(sendPage: SendPage): Promise<{ usedGuest: boolean; user: string }> {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < 20000) {
    try {
      return await evaluate(sendPage, `new Promise((resolve, reject) => {
        const deadline = Date.now() + 6000;
        function done(usedGuest) {
          const user = document.querySelector(".header-user")?.textContent?.trim() || "";
          resolve({ usedGuest, user });
        }
        function tick() {
          const shell = document.querySelector(".app-shell");
          if (shell) { done(false); return; }
          const guest = document.querySelector(".auth-guest");
          if (guest) {
            guest.click();
            waitAuthed();
            return;
          }
          if (Date.now() > deadline) reject(new Error("installed app shell did not render"));
          else setTimeout(tick, 100);
        }
        function waitAuthed() {
          const shell = document.querySelector(".app-shell");
          if (shell) done(true);
          else if (Date.now() > deadline) reject(new Error("guest auth did not reach app shell"));
          else setTimeout(waitAuthed, 100);
        }
        tick();
      })`) as { usedGuest: boolean; user: string };
    } catch (error) {
      lastError = errorDetails(error);
      if (!/Execution context was destroyed|Cannot find context|Target closed/i.test(lastError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`installed app shell did not stabilize: ${lastError}`);
}

async function closeOnboarding(sendPage: SendPage): Promise<boolean> {
  return await evaluate(sendPage, `new Promise((resolve) => {
    const panel = document.querySelector(".onboarding-panel");
    if (!panel) { resolve(false); return; }
    const buttons = Array.from(panel.querySelectorAll("button"));
    const done = buttons.find((button) => button.textContent?.trim() === "完成")
      || buttons.find((button) => button.textContent?.trim() === "稍后再说")
      || panel.querySelector(".onboarding-close");
    if (done) done.click();
    setTimeout(() => resolve(true), 250);
  })`) as boolean;
}

async function selectMode(sendPage: SendPage, mode: string): Promise<void> {
  await evaluate(sendPage, `new Promise((resolve, reject) => {
    const select = document.querySelector(".mode-select");
    if (!select) { reject(new Error("mode select missing")); return; }
    select.value = ${JSON.stringify(mode)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
}

async function openPanel(sendPage: SendPage, label: string): Promise<void> {
  await evaluate(sendPage, `new Promise((resolve, reject) => {
    const button = Array.from(document.querySelectorAll(".header-actions button"))
      .find((item) => item.textContent?.trim() === ${JSON.stringify(label)});
    if (!button) { reject(new Error("panel button missing: " + ${JSON.stringify(label)})); return; }
    button.click();
    const deadline = Date.now() + 5000;
    function tick() {
      const drawer = document.querySelector(".side-drawer");
      const loading = drawer?.textContent?.includes("正在加载面板");
      if (drawer && !loading) requestAnimationFrame(() => requestAnimationFrame(resolve));
      else if (Date.now() > deadline) reject(new Error("panel did not settle: " + ${JSON.stringify(label)}));
      else setTimeout(tick, 100);
    }
    tick();
  })`);
}

async function openSettings(sendPage: SendPage, tab: string): Promise<void> {
  await evaluate(sendPage, `new Promise((resolve, reject) => {
    const settings = Array.from(document.querySelectorAll(".header-actions button"))
      .find((item) => item.textContent?.includes("设置"));
    if (!settings) { reject(new Error("settings button missing")); return; }
    settings.click();
    const deadline = Date.now() + 5000;
    function chooseTab() {
      const dialog = document.querySelector('[role="dialog"][aria-label="设置"]');
      if (!dialog) {
        if (Date.now() > deadline) reject(new Error("settings dialog missing"));
        else setTimeout(chooseTab, 100);
        return;
      }
      const tabButton = Array.from(dialog.querySelectorAll("button"))
        .find((item) => item.textContent?.trim() === ${JSON.stringify(tab)});
      if (tabButton) tabButton.click();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }
    chooseTab();
  })`);
}

async function closeSettings(sendPage: SendPage): Promise<void> {
  await evaluate(sendPage, `new Promise((resolve) => {
    const dialog = document.querySelector('[role="dialog"][aria-label="设置"]');
    const close = dialog ? Array.from(dialog.querySelectorAll("button")).find((item) => item.textContent?.trim() === "×") : null;
    if (close) close.click();
    setTimeout(resolve, 150);
  })`);
}

async function scanView(sendPage: SendPage, name: string): Promise<ViewSnapshot> {
  const contrast = readContrastSnapshot(await evaluate(sendPage, `(() => {
    const parseRgb = (value) => {
      const match = String(value || "").match(/rgba?\\(([^)]+)\\)/i);
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((part) => Number.isNaN(part))) return null;
      const alpha = parts.length >= 4 && !Number.isNaN(parts[3]) ? parts[3] : 1;
      return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
    };
    const blend = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      if (a <= 0) return { r: 255, g: 255, b: 255, a: 1 };
      return {
        r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
        g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
        b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
        a
      };
    };
    const backgroundFor = (element) => {
      let color = { r: 255, g: 255, b: 255, a: 1 };
      const chain = [];
      for (let current = element; current; current = current.parentElement) chain.push(current);
      for (const current of chain.reverse()) {
        const parsed = parseRgb(getComputedStyle(current).backgroundColor);
        if (parsed && parsed.a > 0) color = blend(parsed, color);
      }
      return color;
    };
    const luminance = (rgb) => {
      const channel = (value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
    };
    const contrastRatio = (fg, bg) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const rgbText = (rgb) => "rgb(" + Math.round(rgb.r) + ", " + Math.round(rgb.g) + ", " + Math.round(rgb.b) + ")";
    const selectorFor = (element) => {
      if (element.id) return "#" + element.id;
      const cls = Array.from(element.classList || []).slice(0, 3).join(".");
      return element.tagName.toLowerCase() + (cls ? "." + cls : "");
    };
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01
        && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0
        && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const leafTextElements = Array.from(document.body.querySelectorAll("body *"))
      .filter((element) => isVisible(element))
      .filter((element) => {
        const text = (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ");
        if (!text) return false;
        const childWithSameText = Array.from(element.children).some((child) => {
          const childText = (child.innerText || child.textContent || "").trim().replace(/\\s+/g, " ");
          return childText && text.includes(childText) && isVisible(child);
        });
        return !childWithSameText || ["BUTTON", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(element.tagName);
      });
    const issues = [];
    let checked = 0;
    for (const element of leafTextElements) {
      const style = getComputedStyle(element);
      const fg = parseRgb(style.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = backgroundFor(element);
      const ratio = contrastRatio(fg, bg);
      const fontSize = Number.parseFloat(style.fontSize || "0");
      const fontWeight = style.fontWeight || "";
      const large = fontSize >= 24 || (fontSize >= 18.66 && Number.parseInt(fontWeight, 10) >= 700);
      const threshold = large ? 3 : 4.5;
      checked += 1;
      if (ratio + 0.01 < threshold) {
        issues.push({
          selector: selectorFor(element),
          text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120),
          color: rgbText(fg),
          background: rgbText(bg),
          ratio: Number(ratio.toFixed(2)),
          fontSize,
          fontWeight
        });
      }
    }
    const send = document.querySelector(".send-button");
    const sendStyle = send ? getComputedStyle(send) : null;
    const sendFg = sendStyle ? parseRgb(sendStyle.color) : null;
    const sendBg = send ? backgroundFor(send) : null;
    const timeline = document.querySelector(".timeline");
    const liveRegions = Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      ariaLive: element.getAttribute("aria-live"),
      label: element.getAttribute("aria-label"),
      text: (element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120)
    }));
    return {
      checked,
      issues,
      sendButton: send && sendFg && sendBg ? {
        text: (send.textContent || "").trim(),
        color: rgbText(sendFg),
        background: rgbText(sendBg),
        ratio: Number(contrastRatio(sendFg, sendBg).toFixed(2))
      } : null,
      liveRegions,
      timeline: {
        exists: Boolean(timeline),
        role: timeline?.getAttribute("role") || null,
        ariaLive: timeline?.getAttribute("aria-live") || null,
        ariaRelevant: timeline?.getAttribute("aria-relevant") || null,
        label: timeline?.getAttribute("aria-label") || null
      },
      scroll: {
        width: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        height: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight
      }
    };
  })()`));
  return await evaluate(sendPage, `({ title: document.title, url: location.href })`)
    .then((page) => {
      const info = isRecord(page) ? page : {};
      return {
        name,
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
        contrast,
      };
    });
}

async function readAxSummary(sendPage: SendPage): Promise<AxSummary> {
  const result = await sendPage<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree');
  const nodes = result.nodes || [];
  const roleValue = (node: AxNode) => String(node.role?.value || '').toLowerCase();
  const nameValue = (node: AxNode) => String(node.name?.value || '').trim();
  const statusNodes = nodes.filter((node) => ['status', 'alert'].includes(roleValue(node)));
  const logNodes = nodes.filter((node) => roleValue(node) === 'log');
  return {
    nodeCount: nodes.length,
    statusLikeCount: statusNodes.length,
    logLikeCount: logNodes.length,
    statusSamples: statusNodes.map(nameValue).filter(Boolean).slice(0, 8),
    logSamples: logNodes.map(nameValue).filter(Boolean).slice(0, 8),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(reportDir, { recursive: true });
  ensureWorkspace();
  assert(fs.existsSync(installedExe), `Installed executable not found: ${installedExe}`);

  const debugPort = await getFreePort();
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
    KCW_TRUSTED_ROOT: workspace,
    KCW_STORE: 'sqlite',
    KCW_SQLITE_PATH: path.join(workspace, '.AgentCowork', 'state.sqlite'),
  };
  const child = spawn(installedExe, [`--workspace="${workspace}"`], {
    cwd: path.dirname(installedExe),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const stderr: string[] = [];
  child.stderr.on('data', (chunk: string | Buffer): void => {
    stderr.push(String(chunk));
  });

  let client: CdpClient | undefined;
  const views: ViewSnapshot[] = [];
  let axSummary: AxSummary | null = null;
  let auth: { usedGuest: boolean; user: string } | null = null;
  let onboardingClosed = false;
  try {
    const target = await waitForTarget(debugPort);
    assert(target.webSocketDebuggerUrl, 'WebView target did not expose websocket URL');
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    const sendPage: SendPage = (method, params = {}) => {
      assert(client, 'DevTools client is not open');
      return client.send(method, params);
    };
    await sendPage('Page.enable');
    await sendPage('Runtime.enable');
    await sendPage('Accessibility.enable');
    await sendPage('Emulation.setDeviceMetricsOverride', {
      width: 1536,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    auth = await waitForShell(sendPage);
    onboardingClosed = await closeOnboarding(sendPage);

    views.push(await scanView(sendPage, 'main:execute'));
    for (const mode of ['plan', 'execute', 'yolo']) {
      await selectMode(sendPage, mode);
      views.push(await scanView(sendPage, `mode:${mode}`));
    }
    for (const label of panelLabels) {
      await openPanel(sendPage, label);
      views.push(await scanView(sendPage, `panel:${label}`));
    }
    for (const tab of settingsTabs) {
      await openSettings(sendPage, tab);
      views.push(await scanView(sendPage, `settings:${tab}`));
    }
    await closeSettings(sendPage);

    axSummary = await readAxSummary(sendPage);
    const allIssues = views.flatMap((view) => view.contrast.issues.map((issue) => ({ view: view.name, ...issue })));
    const sendButtons = views.map((view) => view.contrast.sendButton).filter((button): button is NonNullable<ContrastSnapshot['sendButton']> => Boolean(button));
    const liveRegionCount = Math.max(...views.map((view) => view.contrast.liveRegions.length), 0);
    const timelineOk = views.some((view) => view.contrast.timeline.exists
      && view.contrast.timeline.role === 'log'
      && view.contrast.timeline.ariaLive === 'polite');
    const overflowIssues = views.filter((view) => view.contrast.scroll.width > view.contrast.scroll.clientWidth + 1);
    const sendButtonMinContrast = sendButtons.length ? Math.min(...sendButtons.map((button) => button.ratio)) : 0;
    const ok = allIssues.length === 0
      && sendButtonMinContrast >= 4.5
      && liveRegionCount > 0
      && timelineOk
      && overflowIssues.length === 0
      && (axSummary.logLikeCount > 0 || timelineOk);

    const report = {
      ok,
      mode: 'installed-a11y',
      generatedAt: new Date().toISOString(),
      installedExe,
      workspace,
      debugPort,
      auth,
      onboardingClosed,
      summary: {
        viewsScanned: views.length,
        contrastIssues: allIssues.length,
        sendButtonMinContrast,
        liveRegionCount,
        timelineOk,
        overflowIssues: overflowIssues.map((view) => view.name),
        axSummary,
      },
      views,
      issues: allIssues,
      stderr: stderr.join('').slice(-4000),
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    assert(ok, `installed a11y smoke failed; see ${reportPath}`);
  } finally {
    client?.close();
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`- installed a11y report: ${path.relative(repoRoot, reportPath)}`);
}

main().catch((error) => {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    if (!fs.existsSync(reportPath)) {
      fs.writeFileSync(reportPath, JSON.stringify({
        ok: false,
        mode: 'installed-a11y',
        generatedAt: new Date().toISOString(),
        installedExe,
        workspace,
        error: errorDetails(error),
      }, null, 2), 'utf8');
    }
  } catch {
    // ignore report write failures in the error path
  }
  console.error(errorDetails(error));
  process.exit(1);
});
