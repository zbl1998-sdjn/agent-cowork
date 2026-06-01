import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  createOAuthTestStore,
  jsonResponse,
  parseApprovalResponse,
  parseCompleteResponse,
  parseOAuthStatus,
  parseStartResponse,
  type OAuthFetchCall,
} from './helpers/connector-oauth.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

test('GitHub OAuth device flow stores the token sealed and returns only safe connector state', async () => {
  const root = tempRoot('kcw-oauth-');
  const { credentialFile, credentialStore } = createOAuthTestStore(root);
  const calls: OAuthFetchCall[] = [];
  const accessToken = 'dummy-github-oauth-token';
  const oauthFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
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
      const headers = init.headers as Record<string, string> | undefined;
      assert.equal(headers?.authorization, `Bearer ${accessToken}`);
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
    const approval = await jsonRequest(base, '/api/connectors/oauth/approve', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user'] },
    });
    assert.equal(approval.status, 200);
    const approvalBody = parseApprovalResponse(approval.body);
    const start = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user'], approvalId: approvalBody.approvalId },
    });
    assert.equal(start.status, 200);
    const startBody = parseStartResponse(start.body);
    assert.equal(startBody.provider, 'github');
    assert.equal(startBody.userCode, 'ABCD-1234');
    assert.equal(JSON.stringify(start.body).includes('device-secret-code'), false);

    const complete = await jsonRequest(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: startBody.sessionId },
    });
    assert.equal(complete.status, 200);
    const completeBody = parseCompleteResponse(complete.body);
    assert.equal(completeBody.connected, true);
    assert.equal(completeBody.account?.login, 'octocat');
    assert.equal(JSON.stringify(complete.body).includes(accessToken), false);
    assert.equal(fs.readFileSync(credentialFile, 'utf8').includes(accessToken), false);

    const status = await jsonRequest(base, '/api/connectors/oauth/status?id=github');
    assert.equal(status.status, 200);
    const statusBody = parseOAuthStatus(status.body);
    assert.equal(statusBody.connected, true);
    assert.deepEqual((statusBody.accounts || []).map((account) => account.accountId), ['octocat']);
    assert.equal(JSON.stringify(status.body).includes(accessToken), false);
  } finally {
    await close(server);
  }
  assert.equal(calls.length, 3);
});

test('GitHub OAuth complete reports pending authorization without storing a token', async () => {
  const root = tempRoot('kcw-oauth-');
  const { credentialFile, credentialStore } = createOAuthTestStore(root);
  const oauthFetch = async (url: string | URL | Request): Promise<Response> => {
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
    const approval = await jsonRequest(base, '/api/connectors/oauth/approve', { method: 'POST', body: { id: 'github' } });
    assert.equal(approval.status, 200);
    const approvalBody = parseApprovalResponse(approval.body);
    const start = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', approvalId: approvalBody.approvalId },
    });
    const startBody = parseStartResponse(start.body);
    const complete = await jsonRequest(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: startBody.sessionId },
    });
    assert.equal(complete.status, 202);
    assert.equal(parseCompleteResponse(complete.body).status, 'pending');
    assert.equal(fs.existsSync(credentialFile), false);
  } finally {
    await close(server);
  }
});
