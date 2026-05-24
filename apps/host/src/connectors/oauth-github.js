const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

function requireClientId(clientId) {
  const value = String(clientId || '').trim();
  if (!value) {
    const err = new Error('GitHub OAuth client id is required. Set KCW_GITHUB_OAUTH_CLIENT_ID or pass clientId.');
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function normalizeScopes(scopes) {
  const list = Array.isArray(scopes) ? scopes : String(scopes || 'read:user').split(/\s+/);
  const clean = list.map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean : ['read:user'];
}

async function jsonFrom(response, label) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const err = new Error(`${label} failed: ${payload.error_description || payload.error || response.status}`);
    err.statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
    err.payload = payload;
    throw err;
  }
  return payload;
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && String(value) !== '') body.set(key, String(value));
  }
  return body;
}

function headers(extra = {}) {
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
} = {}) {
  const scopeList = normalizeScopes(scopes);
  const response = await fetchImpl(deviceCodeUrl, {
    method: 'POST',
    headers: headers(),
    body: formBody({ client_id: requireClientId(clientId), scope: scopeList.join(' ') }),
  });
  const payload = await jsonFrom(response, 'GitHub device flow start');
  if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
    const err = new Error('GitHub device flow start returned an incomplete response');
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
    const err = new Error(`GitHub OAuth failed: ${payload.error_description || payload.error}`);
    err.statusCode = 400;
    throw err;
  }
  if (!payload.access_token) {
    const err = new Error('GitHub OAuth did not return an access token');
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
