// @ts-check

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

/**
 * @typedef {Error & { statusCode?: number, payload?: unknown }} OAuthError
 */

/**
 * @param {unknown} clientId
 * @returns {string}
 */
function requireClientId(clientId) {
  const value = String(clientId || '').trim();
  if (!value) {
    const err = /** @type {OAuthError} */ (new Error('GitHub OAuth client id is required. Set KCW_GITHUB_OAUTH_CLIENT_ID or pass clientId.'));
    err.statusCode = 400;
    throw err;
  }
  return value;
}

/**
 * @param {unknown} scopes
 * @returns {string[]}
 */
function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || 'read:user').split(/\s+/);
  const clean = list.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : ['read:user'];
}

/**
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<Record<string, unknown>>}
 */
async function jsonFrom(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const description = typeof payload.error_description === 'string' ? payload.error_description : '';
    const error = typeof payload.error === 'string' ? payload.error : '';
    const err = /** @type {OAuthError} */ (new Error(`${label} failed: ${description || error || response.status}`));
    err.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    err.payload = payload;
    throw err;
  }
  return payload;
}

/**
 * @param {Record<string, unknown>} values
 * @returns {URLSearchParams}
 */
function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value) !== '') body.set(key, String(value));
  }
  return body;
}

/**
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function headers(extra = {}) {
  return {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'Agent-Cowork',
    ...extra,
  };
}

/**
 * @typedef {object} StartGitHubDeviceFlowOptions
 * @property {unknown} [clientId]
 * @property {unknown} [scopes]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [deviceCodeUrl]
 *
 * @typedef {object} GitHubDeviceFlowStart
 * @property {'github'} provider
 * @property {string} deviceCode
 * @property {string} userCode
 * @property {string} verificationUri
 * @property {number} expiresIn
 * @property {number} interval
 * @property {string[]} scopes
 */

/**
 * @param {StartGitHubDeviceFlowOptions} [options]
 * @returns {Promise<GitHubDeviceFlowStart>}
 */
export async function startGitHubDeviceFlow({
  clientId,
  scopes,
  fetchImpl = fetch,
  deviceCodeUrl = GITHUB_DEVICE_CODE_URL,
} = {}) {
  const scopeList = normalizeScopes(scopes);
  const response = await fetchImpl(deviceCodeUrl, {
    method: 'POST',
    headers: headers(),
    body: formBody({ client_id: requireClientId(clientId), scope: scopeList.join(' ') }),
  });
  const payload = await jsonFrom(response, 'GitHub device flow start');
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    const err = /** @type {OAuthError} */ (new Error('GitHub device flow start returned an incomplete response'));
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

/**
 * @typedef {object} CompleteGitHubDeviceFlowOptions
 * @property {unknown} [clientId]
 * @property {unknown} [deviceCode]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [accessTokenUrl]
 *
 * @typedef {object} GitHubDeviceFlowPending
 * @property {'pending'} status
 * @property {string} error
 * @property {number} interval
 *
 * @typedef {object} GitHubDeviceFlowConnected
 * @property {'connected'} status
 * @property {string} accessToken
 * @property {string} tokenType
 * @property {string} scope
 */

/**
 * @param {CompleteGitHubDeviceFlowOptions} [options]
 * @returns {Promise<GitHubDeviceFlowPending | GitHubDeviceFlowConnected>}
 */
export async function completeGitHubDeviceFlow({
  clientId,
  deviceCode,
  fetchImpl = fetch,
  accessTokenUrl = GITHUB_ACCESS_TOKEN_URL,
} = {}) {
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
    const description = typeof payload.error_description === 'string' ? payload.error_description : '';
    const error = typeof payload.error === 'string' ? payload.error : '';
    const err = /** @type {OAuthError} */ (new Error(`GitHub OAuth failed: ${description || error}`));
    err.statusCode = 400;
    throw err;
  }
  if (!payload.access_token) {
    const err = /** @type {OAuthError} */ (new Error('GitHub OAuth did not return an access token'));
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

/**
 * @typedef {object} FetchGitHubViewerOptions
 * @property {unknown} [accessToken]
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [userUrl]
 *
 * @typedef {object} GitHubViewer
 * @property {string} login
 * @property {unknown} id
 * @property {unknown} name
 * @property {unknown} email
 */

/**
 * @param {FetchGitHubViewerOptions} [options]
 * @returns {Promise<GitHubViewer>}
 */
export async function fetchGitHubViewer({
  accessToken,
  fetchImpl = fetch,
  userUrl = GITHUB_USER_URL,
} = {}) {
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
