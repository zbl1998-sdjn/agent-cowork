import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  createOAuthTestStore,
  firstOAuthCall,
  jsonResponse,
  parseApprovalResponse,
  parseOAuthStatus,
  parseStartResponse,
  type OAuthFetchCall,
} from './helpers/connector-oauth.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

test('GitHub OAuth start requires approved connector scopes', async () => {
  const root = tempRoot('kcw-oauth-');
  const { credentialStore } = createOAuthTestStore(root);
  const calls: OAuthFetchCall[] = [];
  const oauthFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(url), body: String(init.body || '') });
    if (String(url).endsWith('/login/device/code')) {
      return jsonResponse({
        device_code: 'device-with-approved-scopes',
        user_code: 'SCOP-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
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
    const blocked = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user', 'repo'] },
    });
    assert.equal(blocked.status, 428);
    assert.match(String(blocked.body.error), /approval/i);
    assert.equal(calls.length, 0);

    const rejected = await jsonRequest(base, '/api/connectors/oauth/approve', {
      method: 'POST',
      body: { id: 'github', scopes: ['delete_repo'] },
    });
    assert.equal(rejected.status, 400);
    assert.equal(calls.length, 0);

    const approved = await jsonRequest(base, '/api/connectors/oauth/approve', {
      method: 'POST',
      body: { id: 'github', scopes: ['repo', 'read:user'] },
    });
    assert.equal(approved.status, 200);
    const approvedBody = parseApprovalResponse(approved.body);
    assert.deepEqual(approvedBody.scopes, ['read:user', 'repo']);
    assert.ok((approvedBody.permissions || []).some((permission) => permission.id === 'repo' && permission.risk === 'high'));

    const started = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: {
        id: 'github',
        scopes: ['read:user', 'repo'],
        approvalId: approvedBody.approvalId,
      },
    });
    assert.equal(started.status, 200);
    const startedBody = parseStartResponse(started.body);
    assert.equal(startedBody.userCode, 'SCOP-1234');
    assert.deepEqual(startedBody.scopes, ['read:user', 'repo']);
    assert.equal(calls.length, 1);
    assert.match(firstOAuthCall(calls).body, /scope=read%3Auser\+repo/);

    const replay = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: {
        id: 'github',
        scopes: ['read:user', 'repo'],
        approvalId: approvedBody.approvalId,
      },
    });
    assert.equal(replay.status, 403);
    assert.equal(calls.length, 1);
  } finally {
    await close(server);
  }
});

test('GitHub OAuth start only accepts host-configured client id and preserves approval on missing config', async () => {
  const previousClientId = process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  const previousLegacyClientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  const root = tempRoot('kcw-oauth-');
  const { credentialStore } = createOAuthTestStore(root);
  const calls: OAuthFetchCall[] = [];
  const oauthFetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url: String(url), body: String(init.body || '') });
    if (String(url).endsWith('/login/device/code')) {
      return jsonResponse({
        device_code: 'device-after-config',
        user_code: 'CONF-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const server = createServer({
    trustedRoot: root,
    requireAuth: false,
    enableScheduler: false,
    credentialStore,
    oauthFetch,
    oauthConfig: { github: {} },
  });
  const base = await bind(server);
  try {
    const status = await jsonRequest(base, '/api/connectors/oauth/status?id=github');
    assert.equal(status.status, 200);
    const statusBody = parseOAuthStatus(status.body);
    assert.equal(statusBody.configured, false);
    assert.deepEqual(statusBody.requiredEnv, ['ACW_GITHUB_OAUTH_CLIENT_ID', 'KCW_GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_ID']);
    assert.match(statusBody.configurationMessage || '', /ACW_GITHUB_OAUTH_CLIENT_ID/);

    const approved = await jsonRequest(base, '/api/connectors/oauth/approve', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user'] },
    });
    assert.equal(approved.status, 200);
    const approvedBody = parseApprovalResponse(approved.body);
    const missingConfig = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: {
        id: 'github',
        clientId: 'body-client',
        scopes: ['read:user'],
        approvalId: approvedBody.approvalId,
      },
    });
    assert.equal(missingConfig.status, 428);
    assert.equal(missingConfig.body.code, 'OAUTH_NOT_CONFIGURED');
    assert.match(String(missingConfig.body.error), /ACW_GITHUB_OAUTH_CLIENT_ID/);
    assert.equal(calls.length, 0);

    process.env.KCW_GITHUB_OAUTH_CLIENT_ID = 'env-client';
    const started = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: {
        id: 'github',
        clientId: 'body-client',
        scopes: ['read:user'],
        approvalId: approvedBody.approvalId,
      },
    });
    assert.equal(started.status, 200);
    assert.equal(parseStartResponse(started.body).userCode, 'CONF-1234');
    assert.equal(calls.length, 1);
    const firstCall = firstOAuthCall(calls);
    assert.match(firstCall.body, /client_id=env-client/);
    assert.doesNotMatch(firstCall.body, /body-client/);
  } finally {
    if (previousClientId === undefined) delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
    else process.env.KCW_GITHUB_OAUTH_CLIENT_ID = previousClientId;
    if (previousLegacyClientId === undefined) delete process.env.GITHUB_OAUTH_CLIENT_ID;
    else process.env.GITHUB_OAUTH_CLIENT_ID = previousLegacyClientId;
    await close(server);
  }
});
