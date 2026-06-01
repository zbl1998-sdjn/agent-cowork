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
const defaultReportPath = path.join(buildDir, 'react-artifacts-smoke-report.json');
const archiveRequested = process.env.REACT_ARTIFACTS_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_ARTIFACTS_REPORT_DIR || path.join(repoRoot, 'reports', 'react-artifacts'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-artifacts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-artifacts-smoke-1280x760.png');

type ArtifactSnapshot = {
  hasPanel?: boolean;
  hasCard?: boolean;
  cardText?: string;
  cardCount: number;
  hasRenamedCard?: boolean;
  oldNameVisible?: boolean;
  newNameVisible?: boolean;
  errorText?: string;
};

function artifactSnapshot(value: unknown, label: string): ArtifactSnapshot {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    hasPanel: value.hasPanel === true,
    hasCard: value.hasCard === true,
    cardText: typeof value.cardText === 'string' ? value.cardText : '',
    cardCount: typeof value.cardCount === 'number' ? value.cardCount : 0,
    hasRenamedCard: value.hasRenamedCard === true,
    oldNameVisible: value.oldNameVisible === true,
    newNameVisible: value.newNameVisible === true,
    errorText: typeof value.errorText === 'string' ? value.errorText : '',
  };
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
  let baseUrl: string | null = null;
  let browser: ChildProcessLike | null = null;
  let client: CdpClient | null = null;
  let userDataDir: string | null = null;
  const stderr: string[] = [];

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
          const workspaceReady = document.querySelector('.workspace-chip')?.getAttribute('title')?.includes(${JSON.stringify(workspace)});
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

    const beforeRename = artifactSnapshot(await evaluate(
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
    ), 'beforeRename');

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

    const afterRename = artifactSnapshot(await evaluate(
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
    ), 'afterRename');

    assert(beforeRename.hasCard, 'artifact panel did not list the seeded artifact');
    assert(afterRename.hasRenamedCard, 'artifact panel did not show the renamed artifact');
    assert(fs.existsSync(renamedArtifact), 'renamed artifact does not exist on disk');
    assert(!fs.existsSync(originalArtifact), 'original artifact still exists after rename');

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
