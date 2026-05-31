// GitHub OAuth(host · L1 领域层 · connectors)
// ---------------------------------------------------------------------------
// 职责:GitHub 设备码(device flow)OAuth——发起设备码、轮询换取 access token、拉取用户信息。
//       适合桌面端无回调 URL 的场景;凭据最终经 credential-store 加密保存。
// 依赖:无内部依赖(直连 GitHub API)。导出:device flow 各步骤函数。
//
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

type OAuthError = Error & { statusCode?: number; payload?: unknown };
type FetchImpl = typeof fetch;
type JsonObject = Record<string, unknown>;

export type StartGitHubDeviceFlowOptions = {
  clientId?: unknown;
  scopes?: unknown;
  fetchImpl?: FetchImpl;
  deviceCodeUrl?: string;
};

export type GitHubDeviceFlowStart = {
  provider: 'github';
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  scopes: string[];
};

export type CompleteGitHubDeviceFlowOptions = {
  clientId?: unknown;
  deviceCode?: unknown;
  fetchImpl?: FetchImpl;
  accessTokenUrl?: string;
};

export type GitHubDeviceFlowPending = {
  status: 'pending';
  error: string;
  interval: number;
};

export type GitHubDeviceFlowConnected = {
  status: 'connected';
  accessToken: string;
  tokenType: string;
  scope: string;
};

export type FetchGitHubViewerOptions = {
  accessToken?: unknown;
  fetchImpl?: FetchImpl;
  userUrl?: string;
};

export type GitHubViewer = {
  login: string;
  id: unknown;
  name: unknown;
  email: unknown;
};

function requireClientId(clientId: unknown): string {
  const value = String(clientId || '').trim();
  if (!value) {
    const err = new Error('GitHub OAuth client id is required. Set KCW_GITHUB_OAUTH_CLIENT_ID or pass clientId.') as OAuthError;
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function normalizeScopes(scopes: unknown): string[] {
  const list = Array.isArray(scopes) ? scopes : String(scopes || 'read:user').split(/\s+/);
  const clean = list.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : ['read:user'];
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function stringField(payload: JsonObject, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

async function jsonFrom(response: Response, label: string): Promise<JsonObject> {
  let payload: JsonObject;
  try {
    payload = asJsonObject(await response.json());
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const description = stringField(payload, 'error_description');
    const error = stringField(payload, 'error');
    const err = new Error(`${label} failed: ${description || error || response.status}`) as OAuthError;
    err.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function formBody(values: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value) !== '') body.set(key, String(value));
  }
  return body;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'Agent-Cowork',
    ...extra,
  };
}

export async function startGitHubDeviceFlow({
  clientId,
  scopes,
  fetchImpl = fetch,
  deviceCodeUrl = GITHUB_DEVICE_CODE_URL,
}: StartGitHubDeviceFlowOptions = {}): Promise<GitHubDeviceFlowStart> {
  const scopeList = normalizeScopes(scopes);
  const response = await fetchImpl(deviceCodeUrl, {
    method: 'POST',
    headers: headers(),
    body: formBody({ client_id: requireClientId(clientId), scope: scopeList.join(' ') }),
  });
  const payload = await jsonFrom(response, 'GitHub device flow start');
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    const err = new Error('GitHub device flow start returned an incomplete response') as OAuthError;
    err.statusCode = 502;
    throw err;
  }
  return {
    provider: 'github',
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code),
    verificationUri: String(payload.verification_uri),
    expiresIn: Number(payload.expires_in || 900),
    interval: Number(payload.interval || 5),
    scopes: scopeList,
  };
}

export async function completeGitHubDeviceFlow({
  clientId,
  deviceCode,
  fetchImpl = fetch,
  accessTokenUrl = GITHUB_ACCESS_TOKEN_URL,
}: CompleteGitHubDeviceFlowOptions = {}): Promise<GitHubDeviceFlowPending | GitHubDeviceFlowConnected> {
  const response = await fetchImpl(accessTokenUrl, {
    method: 'POST',
    headers: headers(),
    body: formBody({
      client_id: requireClientId(clientId),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const payload = await jsonFrom(response, 'GitHub device flow complete');
  if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
    return {
      status: 'pending',
      error: String(payload.error),
      interval: Number(payload.interval || (payload.error === 'slow_down' ? 10 : 5)),
    };
  }
  if (payload.error) {
    const description = stringField(payload, 'error_description');
    const error = stringField(payload, 'error');
    const err = new Error(`GitHub OAuth failed: ${description || error}`) as OAuthError;
    err.statusCode = 400;
    throw err;
  }
  if (!payload.access_token) {
    const err = new Error('GitHub OAuth did not return an access token') as OAuthError;
    err.statusCode = 502;
    throw err;
  }
  return {
    status: 'connected',
    accessToken: String(payload.access_token),
    tokenType: String(payload.token_type || 'bearer'),
    scope: String(payload.scope || ''),
  };
}

export async function fetchGitHubViewer({
  accessToken,
  fetchImpl = fetch,
  userUrl = GITHUB_USER_URL,
}: FetchGitHubViewerOptions = {}): Promise<GitHubViewer> {
  const response = await fetchImpl(userUrl, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'Agent-Cowork',
    },
  });
  const payload = await jsonFrom(response, 'GitHub user lookup');
  return {
    login: String(payload.login || 'github-user'),
    id: payload.id,
    name: payload.name,
    email: payload.email,
  };
}
