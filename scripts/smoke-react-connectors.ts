// React 连接器(MCP/OAuth)smoke(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:用无头浏览器拉起 host server 与 React UI,验证"连接器"侧栏的全链路:
//       文件系统连接器一键连接/断开(校验 mcp__fs__read_text 工具的注册与注销)、
//       GitHub OAuth 设备流(默认走 mock fetch:审批权限→去登录授权→完成授权→
//       撤销授权,断言凭据存储不泄露明文 token);并单独跑一遍"缺少 client id"
//       的预检场景(start 返回 428 / OAUTH_NOT_CONFIGURED,配置后审批可复用)。
//       报告写出前统一脱敏(redact token/secret/Bearer)。
// 用法:由对应 npm script 经 run-host-node 触发;加 --live-github 或置
//       REACT_CONNECTORS_LIVE_GITHUB=1 走真实 GitHub 设备流(需
//       KCW_GITHUB_OAUTH_CLIENT_ID);REACT_CONNECTORS_ARCHIVE=1 归档报告到
//       reports/react-connectors。
// 依赖:apps/host/src/server.js、security/credential-store、./browser-smoke-utils;
//       需先 npm run build:ui。失败即 exit 1。
import { spawn } from 'node:child_process';
import type { ChildProcessLike } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { ServerConfig } from '../apps/host/src/server.js';
import { createCredentialStore } from '../apps/host/src/security/credential-store.js';
import type { CredentialProtector } from '../apps/host/src/security/credential-store.js';
import {
  CdpClient,
  assert,
  bind,
  errorDetails,
  evaluate,
  findBrowser,
  getFreePort,
  getJson,
  type CdpSession,
  type CdpTarget,
  type CdpVersion,
  type ScreenshotResult,
  type SendPage,
} from './browser-smoke-utils.js';

type JsonObject = Record<string, unknown>;
type RequestHeaders = Record<string, string>;
type SmokeProtector = CredentialProtector;
type OAuthFetchCall = { url: string; body: string };
type PostResult<T = JsonObject> = { ok: boolean; statusCode: number; body: T };
type OAuthStatus = {
  configured?: boolean;
  requiredEnv?: string[];
  connected: boolean;
};
type ToolSearchResponse = { tools: Array<{ name?: string }> };
type ConnectorsResponse = { connected: string[] };
type OAuthApprovalResponse = { approvalId?: string };
type OAuthStartResponse = {
  sessionId?: string;
  userCode?: string;
  verificationUri?: string;
  interval?: number;
};
type OAuthCompleteResponse = {
  status?: string;
  connected?: boolean;
  account?: { login?: string };
  credential?: { accountId?: string };
  interval?: number;
};
type OAuthRevokeResponse = { removed?: boolean };
type FetchLike = NonNullable<ServerConfig['oauthFetch']>;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const uiDistRoot = path.join(repoRoot, 'apps', 'windows-client', 'ui-dist');
const defaultReportPath = path.join(buildDir, 'react-connectors-smoke-report.json');
const liveGitHubRequested = process.argv.includes('--live-github') || process.env.REACT_CONNECTORS_LIVE_GITHUB === '1';
const archiveRequested = process.env.REACT_CONNECTORS_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.REACT_CONNECTORS_REPORT_DIR || path.join(repoRoot, 'reports', 'react-connectors'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `react-connectors${liveGitHubRequested ? '-live-github' : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;
const screenshotPath = path.join(buildDir, 'react-connectors-smoke-1280x760.png');
const liveGitHubTimeoutMs = Number(process.env.REACT_CONNECTORS_LIVE_GITHUB_TIMEOUT_MS || 5 * 60 * 1000);

function smokeProtector(): SmokeProtector {
  return {
    protect(text: unknown): string {
      return `sealed:${Buffer.from(String(text), 'utf8').toString('base64')}`;
    },
    unprotect(text: unknown): string {
      return Buffer.from(String(text).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function jsonResponse(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function githubClientIdFromEnv(): string {
  return String(process.env.KCW_GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_OAUTH_CLIENT_ID || '').trim();
}

function redactText(text: unknown): string {
  return String(text)
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/gh[oOpsuUrRsS]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

function redactReport<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactReport(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/token|secret|deviceCode|authorization/i.test(key)) return [key, '[redacted]'];
    return [key, redactReport(item)];
  })) as T;
}

async function postJsonRaw<T = JsonObject>(url: string, body: JsonObject, headers: RequestHeaders = {}): Promise<PostResult<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let payload: JsonObject = {};
  try {
    payload = await response.json() as JsonObject;
  } catch {
    payload = {};
  }
  return { ok: response.ok, statusCode: response.status, body: payload as T };
}

async function postJson<T = JsonObject>(url: string, body: JsonObject, headers: RequestHeaders = {}): Promise<{ statusCode: number; body: T }> {
  const result = await postJsonRaw<T>(url, body, headers);
  if (!result.ok) {
    const err = new Error(`${url} returned ${result.statusCode}: ${JSON.stringify(redactReport(result.body))}`) as Error & {
      statusCode?: number;
      payload?: T;
    };
    err.statusCode = result.statusCode;
    err.payload = result.body;
    throw err;
  }
  return { statusCode: result.statusCode, body: result.body };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLiveGitHubOAuthSmoke(baseUrl: string, authHeader: RequestHeaders): Promise<JsonObject> {
  const requestedScopes = ['read:user'];
  const approval = await postJson<OAuthApprovalResponse>(`${baseUrl}/api/connectors/oauth/approve`, {
    id: 'github',
    scopes: requestedScopes,
  }, authHeader);
  assert(String(approval.body.approvalId || '').startsWith('oauth_'), 'GitHub OAuth approval id was not issued');

  const started = await postJson<OAuthStartResponse>(`${baseUrl}/api/connectors/oauth/start`, {
    id: 'github',
    scopes: requestedScopes,
    approvalId: approval.body.approvalId,
  }, authHeader);
  assert(started.body.userCode, 'GitHub OAuth live start did not return a user code');
  assert(started.body.verificationUri, 'GitHub OAuth live start did not return a verification URI');

  console.log(`\nGitHub device authorization required:
  Open: ${started.body.verificationUri}
  Code: ${started.body.userCode}
  Scope: ${requestedScopes.join(' ')}
`);

  const deadline = Date.now() + liveGitHubTimeoutMs;
  let complete: OAuthCompleteResponse | null = null;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    const result = await postJson<OAuthCompleteResponse>(`${baseUrl}/api/connectors/oauth/complete`, {
      id: 'github',
      sessionId: started.body.sessionId,
    }, authHeader);
    if (result.statusCode !== 202 && result.body.status !== 'pending') {
      complete = result.body;
      break;
    }
    const intervalMs = Math.max(1, Number(result.body.interval || started.body.interval || 5)) * 1000;
    await sleep(intervalMs);
  }
  assert(complete?.connected === true, 'GitHub OAuth live authorization was not completed before timeout');

  const status = await getJson<OAuthStatus>(`${baseUrl}/api/connectors/oauth/status?id=github`, 5000, authHeader);
  assert(status.connected === true, 'GitHub OAuth live status did not become connected');
  assert(!/(github_pat_|gh[oOpsuUrRsS]_)/.test(JSON.stringify(status)), 'GitHub OAuth status appears to include a plaintext token');

  const revoked = await postJson<OAuthRevokeResponse>(`${baseUrl}/api/connectors/oauth/revoke`, { id: 'github' }, authHeader);
  const statusAfterRevoke = await getJson<OAuthStatus>(`${baseUrl}/api/connectors/oauth/status?id=github`, 5000, authHeader);
  assert(statusAfterRevoke.connected === false, 'GitHub OAuth live status remained connected after revoke');

  return redactReport({
    mode: 'live-github',
    configuredEnv: process.env.KCW_GITHUB_OAUTH_CLIENT_ID ? 'KCW_GITHUB_OAUTH_CLIENT_ID' : 'GITHUB_OAUTH_CLIENT_ID',
    requestedScopes,
    verificationUri: started.body.verificationUri,
    userCodeShown: Boolean(started.body.userCode),
    pollCount,
    accountLogin: complete.account?.login || complete.credential?.accountId || '',
    connected: status.connected,
    revoked: revoked.body.removed,
    connectedAfterRevoke: statusAfterRevoke.connected,
  });
}

async function runMissingGitHubClientIdSmoke(): Promise<JsonObject> {
  const previousClientId = process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  const previousLegacyClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-connectors-no-client-'));
  const credentialPath = path.join(workspace, '.AgentCowork', 'credentials.json');
  const oauthFetchCalls: OAuthFetchCall[] = [];
  const credentialStore = createCredentialStore({
    filePath: credentialPath,
    protector: smokeProtector(),
  });
  const oauthFetch: FetchLike = async (url, init = {}) => {
    oauthFetchCalls.push({ url: String(url), body: String(init.body || '') });
    if (String(url).endsWith('/login/device/code')) {
      return jsonResponse({
        device_code: 'device-after-config',
        user_code: 'NOID-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      });
    }
    throw new Error(`unexpected OAuth fetch: ${url}`);
  };
  const host = createServer({
    trustedRoot: workspace,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    uiDistRoot,
    credentialStore,
    oauthFetch,
    oauthConfig: { github: {} },
  });

  let baseUrl = null;
  try {
    baseUrl = await bind(host);
    const status = await getJson<OAuthStatus>(`${baseUrl}/api/connectors/oauth/status?id=github`);
    assert(status.configured === false, 'GitHub OAuth status should report missing client id');
    assert(
      Array.isArray(status.requiredEnv) && status.requiredEnv.includes('KCW_GITHUB_OAUTH_CLIENT_ID'),
      'GitHub OAuth status did not report the required client id env var',
    );

    const approval = await postJson<OAuthApprovalResponse>(`${baseUrl}/api/connectors/oauth/approve`, {
      id: 'github',
      scopes: ['read:user'],
    });
    assert(String(approval.body.approvalId || '').startsWith('oauth_'), 'GitHub OAuth approval id was not issued');

    const missingConfig = await postJsonRaw<{ code?: string; error?: string }>(`${baseUrl}/api/connectors/oauth/start`, {
      id: 'github',
      clientId: 'body-client',
      scopes: ['read:user'],
      approvalId: approval.body.approvalId,
    });
    assert(missingConfig.statusCode === 428, `GitHub OAuth missing client id should return 428, got ${missingConfig.statusCode}`);
    assert(missingConfig.body.code === 'OAUTH_NOT_CONFIGURED', 'GitHub OAuth missing client id returned the wrong error code');
    assert(String(missingConfig.body.error || '').includes('KCW_GITHUB_OAUTH_CLIENT_ID'), 'GitHub OAuth missing client id error did not mention the env var');
    assert(Number(oauthFetchCalls.length) === 0, 'GitHub OAuth missing client id should not call the external device-flow endpoint');

    process.env.KCW_GITHUB_OAUTH_CLIENT_ID = 'smoke-env-client';
    const started = await postJson<OAuthStartResponse>(`${baseUrl}/api/connectors/oauth/start`, {
      id: 'github',
      clientId: 'body-client',
      scopes: ['read:user'],
      approvalId: approval.body.approvalId,
    });
    assert(started.body.userCode === 'NOID-1234', 'GitHub OAuth approval was not reusable after client id was configured');
    assert(Number(oauthFetchCalls.length) === 1, 'GitHub OAuth configured retry should call the device-flow endpoint exactly once');
    const configuredFetchCall = oauthFetchCalls[0];
    assert(configuredFetchCall, 'GitHub OAuth configured retry did not record the device-flow request');
    assert(configuredFetchCall.body.includes('client_id=smoke-env-client'), 'GitHub OAuth configured retry did not use the env client id');
    assert(!configuredFetchCall.body.includes('body-client'), 'GitHub OAuth configured retry used the request body client id');
    assert(!fs.existsSync(credentialPath), 'GitHub OAuth start preflight should not persist credentials');

    return redactReport({
      configuredBeforeStart: status.configured,
      requiredEnv: status.requiredEnv,
      missingStartStatus: missingConfig.statusCode,
      missingStartCode: missingConfig.body.code,
      externalCallsBeforeConfig: 0,
      approvalReusedAfterConfig: true,
      externalCallsAfterConfig: oauthFetchCalls.length,
      credentialFileCreated: fs.existsSync(credentialPath),
    });
  } finally {
    if (previousClientId === undefined) delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
    else process.env.KCW_GITHUB_OAUTH_CLIENT_ID = previousClientId;
    if (previousLegacyClientId === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = previousLegacyClientId;
    if (typeof host.shutdown === 'function') {
      await host.shutdown({ timeoutMs: 3000 });
    } else {
      if (typeof host.closeMcp === 'function') host.closeMcp();
      await new Promise((resolve) => host.close(resolve));
    }
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  assert(fs.existsSync(path.join(uiDistRoot, 'index.html')), 'React UI dist is missing; run npm run build:ui first');
  const browserPath = findBrowser();
  assert(browserPath, 'No Edge or Chrome executable was found for React connectors smoke');
  if (liveGitHubRequested) {
    assert(githubClientIdFromEnv(), 'Set KCW_GITHUB_OAUTH_CLIENT_ID before running --live-github');
  }
  const missingGitHubClientId = await runMissingGitHubClientIdSmoke();

  const workspace = fs.mkdtempSync(path.join(buildDir, 'kcw-react-connectors-'));
  fs.writeFileSync(path.join(workspace, 'connector-smoke.txt'), 'filesystem connector smoke\n', 'utf8');
  const oauthToken = ['gho', 'smoke', 'connector', 'token'].join('_');
  const credentialStore = createCredentialStore({
    filePath: path.join(workspace, '.AgentCowork', 'credentials.json'),
    protector: smokeProtector(),
  });
  const oauthFetch: FetchLike = async (url, init = {}) => {
    const href = String(url);
    if (href.endsWith('/login/device/code')) {
      assert(String(init.body || '').includes('client_id=smoke-client'), 'OAuth start did not send the configured client id');
      return jsonResponse({
        device_code: 'device-smoke-code',
        user_code: 'SMOKE-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      });
    }
    if (href.endsWith('/login/oauth/access_token')) {
      assert(String(init.body || '').includes('device_code=device-smoke-code'), 'OAuth complete did not send the device code');
      return jsonResponse({ access_token: oauthToken, token_type: 'bearer', scope: 'read:user' });
    }
    if (href.endsWith('/user')) {
      assert(
        Boolean(init.headers) && !Array.isArray(init.headers) && (init.headers as Record<string, string>).authorization === `Bearer ${oauthToken}`,
        'OAuth user lookup did not use the stored token',
      );
      return jsonResponse({ login: 'octocat', id: 1 });
    }
    throw new Error(`unexpected OAuth fetch: ${href}`);
  };

  const serverConfig: ServerConfig = {
    trustedRoot: workspace,
    requireAuth: false,
    persistAuth: false,
    enableScheduler: false,
    uiDistRoot,
    credentialStore,
    oauthConfig: liveGitHubRequested ? {} : { github: { clientId: 'smoke-client' } },
  };
  if (!liveGitHubRequested) {
    serverConfig.oauthFetch = oauthFetch;
  }
  const host = createServer(serverConfig);

  const startedAt = Date.now();
  let baseUrl: string | null = null;
  let browser: ChildProcessLike | null = null;
  let client: CdpClient | null = null;
  let userDataDir: string | null = null;
  const stderr: string[] = [];

  try {
    baseUrl = await bind(host);
    const debugPort = await getFreePort();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-connectors-profile-'));
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

    const version = await getJson<CdpVersion>(`http://127.0.0.1:${debugPort}/json/version`, 10000);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();
    const { targetId } = await client.send<CdpTarget>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send<CdpSession>('Target.attachToTarget', { targetId, flatten: true });
    const sendPage: SendPage = (method, params = {}) => {
      assert(client, 'DevTools client is not open');
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
        localStorage.setItem('acw.guest', '1');
        localStorage.setItem('acw.conversations.v1', JSON.stringify([{ id: 'connector-smoke-conv', title: 'P2-B1 connector smoke', messages: [] }]));
      })();`,
    });

    await sendPage('Page.navigate', { url: baseUrl });
    await evaluate(sendPage, 'window.open = () => null; true');
    await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const expectedWorkspace = ${JSON.stringify(workspace)};
        const deadline = Date.now() + 8000;
        function workspaceValue() {
          const chip = document.querySelector('.workspace-chip');
          const title = chip?.getAttribute('title') || '';
          const prefix = '当前工作区:';
          if (title.startsWith(prefix)) {
            return title.slice(prefix.length).split('\\n')[0].trim();
          }
          return chip?.innerText.replace(/^\\S+\\s*/, '').replace(/▾$/, '').trim() || '';
        }
        function normalizePath(value) {
          return String(value || '').replace(/\\//g, '\\\\').replace(/\\\\+$/g, '').toLowerCase();
        }
        function tick() {
          const ready = [...document.querySelectorAll('button')].some((button) => button.innerText.trim() === '连接器')
            && normalizePath(workspaceValue()) === normalizePath(expectedWorkspace);
          if (ready) resolve(true);
          else if (Date.now() > deadline) {
            reject(new Error('React app did not become ready for connectors smoke: '
              + JSON.stringify({ workspace: workspaceValue(), expectedWorkspace })));
          }
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '连接器');
        if (!button) throw new Error('connector panel button missing');
        button.click();
        return true;
      })()`,
    );

    const beforeConnect = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        function snapshot() {
          const panelText = document.querySelector('.side-panel')?.innerText || '';
          const filesystemItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('文件系统'));
          return {
            panelText,
            hasFilesystem: Boolean(filesystemItem),
            hasOneClick: Boolean(filesystemItem && [...filesystemItem.querySelectorAll('button')]
              .some((button) => button.innerText.trim() === '一键连接')),
          };
        }
        function tick() {
          const current = snapshot();
          if (current.hasFilesystem && current.hasOneClick) resolve(current);
          else if (Date.now() > deadline) reject(new Error('filesystem connector not ready in panel: ' + JSON.stringify(current)));
          else setTimeout(tick, 50);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const filesystemItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('文件系统'));
        if (!filesystemItem) throw new Error('filesystem connector item missing');
        const button = [...filesystemItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '一键连接');
        if (!button) throw new Error('filesystem one-click button missing');
        button.click();
        return true;
      })()`,
    );

    const afterConnect = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const text = document.body.innerText;
          const filesystemItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('文件系统'));
          return {
            bodyText: text,
            buttonText: filesystemItem
              ? [...filesystemItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
            connectedText: document.querySelector('.connector-connected')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if ((current.buttonText.includes('已连接') || current.connectedText.includes('fs'))
            && current.resultText.includes('已连接')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('connector did not connect through the UI: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );

    const tools = await getJson<ToolSearchResponse>(`${baseUrl}/api/tools/search?q=read_text&limit=10`);
    assert(tools.tools.some((tool) => tool.name === 'mcp__fs__read_text'), 'filesystem MCP read_text tool was not registered');
    const connectors = await getJson<ConnectorsResponse>(`${baseUrl}/api/connectors`);
    assert(connectors.connected.includes('fs'), 'connector catalog did not report fs as connected');

    await evaluate(
      sendPage,
      `(() => {
        const filesystemItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('文件系统'));
        if (!filesystemItem) throw new Error('filesystem connector item missing before disconnect');
        const button = [...filesystemItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '断开连接');
        if (!button) throw new Error('filesystem disconnect button missing');
        button.click();
        return true;
      })()`,
    );

    const afterDisconnect = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const filesystemItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('文件系统'));
          return {
            buttonText: filesystemItem
              ? [...filesystemItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
            connectedText: document.querySelector('.connector-connected')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if (current.buttonText.includes('一键连接')
            && current.resultText.includes('已断开')
            && !current.connectedText.includes('fs')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('connector did not disconnect through the UI: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );
    const toolsAfterDisconnect = await getJson<ToolSearchResponse>(`${baseUrl}/api/tools/search?q=read_text&limit=10`);
    assert(
      !toolsAfterDisconnect.tools.some((tool) => tool.name === 'mcp__fs__read_text'),
      'filesystem MCP read_text tool remained registered after disconnect',
    );
    const connectorsAfterDisconnect = await getJson<ConnectorsResponse>(`${baseUrl}/api/connectors`);
    assert(!connectorsAfterDisconnect.connected.includes('fs'), 'connector catalog still reported fs as connected');

    let afterOAuthApproval = null;
    let afterOAuthStart = null;
    let afterOAuthComplete = null;
    let afterOAuthRevoke = null;
    let oauthStatus: OAuthStatus = { connected: false };
    let oauthStatusAfterRevoke: OAuthStatus = { connected: false };
    const authToken = String(await evaluate(sendPage, `localStorage.getItem('acw.authToken') || ''`) || '');
    const authHeader = authToken ? { authorization: `Bearer ${authToken}` } : {};

    if (!liveGitHubRequested) {
    await evaluate(
      sendPage,
      `(() => {
        const githubItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('GitHub'));
        if (!githubItem) throw new Error('GitHub OAuth connector item missing');
        if (!githubItem.innerText.includes('读取 GitHub 用户资料')) throw new Error('GitHub OAuth permission checkbox missing');
        const button = [...githubItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '审批权限');
        if (!button) throw new Error('GitHub approve OAuth permissions button missing');
        button.click();
        return true;
      })()`,
    );
    afterOAuthApproval = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const githubItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('GitHub'));
          return {
            itemText: githubItem?.innerText || '',
            buttonText: githubItem
              ? [...githubItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if (current.buttonText.includes('去登录授权') && current.resultText.includes('已审批 GitHub 权限')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('GitHub OAuth permission approval did not render: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const githubItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('GitHub'));
        const button = [...githubItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '去登录授权');
        if (!button) throw new Error('GitHub start OAuth button missing after permission approval');
        button.click();
        return true;
      })()`,
    );
    afterOAuthStart = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const githubItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('GitHub'));
          return {
            buttonText: githubItem
              ? [...githubItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if (current.buttonText.includes('完成授权') && current.resultText.includes('SMOKE-1234')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('GitHub OAuth start did not render the device code: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );

    await evaluate(
      sendPage,
      `(() => {
        const githubItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('GitHub'));
        const button = [...githubItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '完成授权');
        if (!button) throw new Error('GitHub complete OAuth button missing');
        button.click();
        return true;
      })()`,
    );
    afterOAuthComplete = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const githubItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('GitHub'));
          return {
            itemText: githubItem?.innerText || '',
            buttonText: githubItem
              ? [...githubItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if (current.buttonText.includes('撤销授权')
            && current.itemText.includes('已连接')
            && current.resultText.includes('已授权 GitHub')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('GitHub OAuth complete did not mark the connector connected: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );
    assert(authToken, 'guest auth token missing after OAuth connector login');
    oauthStatus = await getJson<OAuthStatus>(`${baseUrl}/api/connectors/oauth/status?id=github`, 5000, authHeader);
    assert(oauthStatus.connected === true, 'GitHub OAuth status did not become connected');
    assert(!JSON.stringify(oauthStatus).includes(oauthToken), 'OAuth status leaked the access token');

    await evaluate(
      sendPage,
      `(() => {
        const githubItem = [...document.querySelectorAll('.tool-list li')]
          .find((item) => item.innerText.includes('GitHub'));
        const button = [...githubItem.querySelectorAll('button')]
          .find((item) => item.innerText.trim() === '撤销授权');
        if (!button) throw new Error('GitHub revoke OAuth button missing');
        button.click();
        return true;
      })()`,
    );
    afterOAuthRevoke = await evaluate(
      sendPage,
      `new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        function snapshot() {
          const githubItem = [...document.querySelectorAll('.tool-list li')]
            .find((item) => item.innerText.includes('GitHub'));
          return {
            itemText: githubItem?.innerText || '',
            buttonText: githubItem
              ? [...githubItem.querySelectorAll('button')].map((button) => button.innerText.trim()).join('|')
              : '',
            resultText: document.querySelector('.panel-result')?.innerText || '',
          };
        }
        function tick() {
          const current = snapshot();
          if (current.buttonText.includes('审批权限')
            && !current.itemText.includes('已连接')
            && current.resultText.includes('已撤销 GitHub')) resolve(current);
          else if (Date.now() > deadline) reject(new Error('GitHub OAuth revoke did not clear the connector state: ' + JSON.stringify(current)));
          else setTimeout(tick, 100);
        }
        tick();
      })`,
    );
    oauthStatusAfterRevoke = await getJson<OAuthStatus>(`${baseUrl}/api/connectors/oauth/status?id=github`, 5000, authHeader);
    assert(oauthStatusAfterRevoke.connected === false, 'GitHub OAuth status remained connected after revoke');
    assert(
      fs.readFileSync(path.join(workspace, '.AgentCowork', 'credentials.json'), 'utf8').includes(oauthToken) === false,
      'credential store leaked the OAuth token',
    );
    }

    const liveGitHub = liveGitHubRequested
      ? await runLiveGitHubOAuthSmoke(baseUrl, authHeader)
      : null;

    const screenshot = await sendPage<ScreenshotResult>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const report = redactReport({
      ok: true,
      mode: liveGitHubRequested ? 'mock-and-live-github' : 'mock',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      screenshotPath,
      reportPath,
      beforeConnect,
      afterConnect,
      afterDisconnect,
      afterOAuthApproval,
      afterOAuthStart,
      afterOAuthComplete,
      afterOAuthRevoke,
      registeredTool: 'mcp__fs__read_text',
      connected: connectors.connected,
      disconnected: connectorsAfterDisconnect.connected,
      oauthConnected: oauthStatus.connected,
      oauthConnectedAfterRevoke: oauthStatusAfterRevoke.connected,
      liveGitHub,
      missingGitHubClientId,
    });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(redactReport({
      ok: true,
      mode: liveGitHubRequested ? 'mock-and-live-github' : 'mock',
      reportPath,
      screenshotPath,
      connected: connectors.connected,
      disconnected: connectorsAfterDisconnect.connected,
      oauthConnected: oauthStatus.connected,
      oauthConnectedAfterRevoke: oauthStatusAfterRevoke.connected,
      liveGitHub,
      missingGitHubClientId,
    }), null, 2));
  } catch (error) {
    const report = redactReport({
      ok: false,
      mode: liveGitHubRequested ? 'mock-and-live-github' : 'mock',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      baseUrl,
      browserPath,
      workspace,
      uiDistRoot,
      reportPath,
      error: errorDetails(error),
      browserStderrTail: stderr.join('').split(/\r?\n/).slice(-40),
    });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.error(redactText(errorDetails(error)));
    process.exitCode = 1;
  } finally {
    client?.close();
    if (browser) browser.kill();
    if (typeof host.shutdown === 'function') {
      await host.shutdown({ timeoutMs: 3000 });
    } else {
      if (typeof host.closeMcp === 'function') host.closeMcp();
      await new Promise((resolve) => host.close(resolve));
    }
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
  const report = redactReport({
    ok: false,
    mode: liveGitHubRequested ? 'mock-and-live-github' : 'mock',
    generatedAt: new Date().toISOString(),
    reportPath,
    error: errorDetails(error),
  });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(redactText(errorDetails(error)));
  process.exit(1);
});
