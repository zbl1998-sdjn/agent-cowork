import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createCredentialStore } from '../src/security/credential-store.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-oauth-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, {
    method: opt.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function testProtector() {
  return {
    protect(text) {
      return `sealed:${Buffer.from(String(text), 'utf8').toString('base64')}`;
    },
    unprotect(text) {
      return Buffer.from(String(text).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('GitHub OAuth device flow stores the token sealed and returns only safe connector state', async () => {
  const root = tmp();
  const credentialFile = path.join(root, 'credentials.json');
  const credentialStore = createCredentialStore({ filePath: credentialFile, protector: testProtector() });
  const calls = [];
  const accessToken = 'gho_SECRET_TOKEN_abcdefghijklmnopqrstuvwxyz';
  const oauthFetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: String(init.body || '') });
    if (String(url).endsWith('/login/device/code')) {
      assert.match(String(init.body), /client_id=test-client/);
      assert.match(String(init.body), /scope=read%3Auser/);
      return jsonResponse({
        device_code: 'device-secret-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (String(url).endsWith('/login/oauth/access_token')) {
      assert.match(String(init.body), /device_code=device-secret-code/);
      return jsonResponse({ access_token: accessToken, token_type: 'bearer', scope: 'read:user' });
    }
    if (String(url).endsWith('/user')) {
      assert.equal(init.headers.authorization, `Bearer ${accessToken}`);
      return jsonResponse({ login: 'octocat', id: 1 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const server = createServer({
    trustedRoot: root,
    requireAuth: false,
    enableScheduler: false,
    credentialStore,
    oauthFetch,
    oauthConfig: { github: { clientId: 'test-client' } },
  });
  const base = await bind(server);
  try {
    const start = await J(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user'] },
    });
    assert.equal(start.status, 200);
    assert.equal(start.body.provider, 'github');
    assert.ok(start.body.sessionId);
    assert.equal(start.body.userCode, 'ABCD-1234');
    assert.equal(JSON.stringify(start.body).includes('device-secret-code'), false);

    const complete = await J(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: start.body.sessionId },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.connected, true);
    assert.equal(complete.body.account.login, 'octocat');
    assert.equal(JSON.stringify(complete.body).includes(accessToken), false);
    assert.equal(fs.readFileSync(credentialFile, 'utf8').includes(accessToken), false);

    const status = await J(base, '/api/connectors/oauth/status?id=github');
    assert.equal(status.status, 200);
    assert.equal(status.body.connected, true);
    assert.deepEqual(status.body.accounts.map((a) => a.accountId), ['octocat']);
    assert.equal(JSON.stringify(status.body).includes(accessToken), false);
  } finally {
    await closeTestServer(server);
  }
  assert.equal(calls.length, 3);
});

test('GitHub OAuth complete reports pending authorization without storing a token', async () => {
  const root = tmp();
  const credentialFile = path.join(root, 'credentials.json');
  const credentialStore = createCredentialStore({ filePath: credentialFile, protector: testProtector() });
  const oauthFetch = async (url) => {
    if (String(url).endsWith('/login/device/code')) {
      return jsonResponse({
        device_code: 'device-pending',
        user_code: 'WXYZ-9876',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    if (String(url).endsWith('/login/oauth/access_token')) {
      return jsonResponse({ error: 'authorization_pending', interval: 5 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const server = createServer({
    trustedRoot: root,
    requireAuth: false,
    enableScheduler: false,
    credentialStore,
    oauthFetch,
    oauthConfig: { github: { clientId: 'test-client' } },
  });
  const base = await bind(server);
  try {
    const start = await J(base, '/api/connectors/oauth/start', { method: 'POST', body: { id: 'github' } });
    const complete = await J(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: start.body.sessionId },
    });
    assert.equal(complete.status, 202);
    assert.equal(complete.body.status, 'pending');
    assert.equal(fs.existsSync(credentialFile), false);
  } finally {
    await closeTestServer(server);
  }
});

test('GitHub OAuth routes reject client secrets and cross-identity sessions', async () => {
  const root = tmp();
  const credentialStore = createCredentialStore({
    filePath: path.join(root, 'credentials.json'),
    protector: testProtector(),
  });
  let fetchCalled = false;
  const oauthSessions = new Map([
    ['foreign-session', {
      provider: 'github',
      clientId: 'test-client',
      deviceCode: 'device-secret-code',
      scopes: ['read:user'],
      tenantId: 'other-tenant',
      userId: 'other-user',
      expiresAtMs: Date.now() + 60_000,
    }],
  ]);
  const server = createServer({
    trustedRoot: root,
    requireAuth: false,
    enableScheduler: false,
    credentialStore,
    oauthSessions,
    oauthFetch: async () => {
      fetchCalled = true;
      return jsonResponse({});
    },
    oauthConfig: { github: { clientId: 'test-client' } },
  });
  const base = await bind(server);
  try {
    const secretStart = await J(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', clientSecret: 'do-not-accept' },
    });
    assert.equal(secretStart.status, 400);
    assert.equal(JSON.stringify(secretStart.body).includes('do-not-accept'), false);

    const complete = await J(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: 'foreign-session' },
    });
    assert.equal(complete.status, 403);
    assert.equal(fetchCalled, false);
  } finally {
    await closeTestServer(server);
  }
});
