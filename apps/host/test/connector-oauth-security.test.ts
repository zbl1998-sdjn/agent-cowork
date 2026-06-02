import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createOAuthTestStore, jsonResponse } from './helpers/connector-oauth.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

test('GitHub OAuth routes reject client secrets and cross-identity sessions', async () => {
  const root = tempRoot('kcw-oauth-');
  const { credentialStore } = createOAuthTestStore(root);
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
    const secretStart = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', clientSecret: 'do-not-accept' },
    });
    assert.equal(secretStart.status, 400);
    assert.equal(JSON.stringify(secretStart.body).includes('do-not-accept'), false);

    const complete = await jsonRequest(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: 'foreign-session' },
    });
    assert.equal(complete.status, 403);
    assert.equal(fetchCalled, false);
  } finally {
    await close(server);
  }
});

test('GitHub OAuth routes validate approval and session route tokens', async () => {
  const root = tempRoot('kcw-oauth-');
  const { credentialStore } = createOAuthTestStore(root);
  let fetchCalled = false;
  const server = createServer({
    trustedRoot: root,
    requireAuth: false,
    enableScheduler: false,
    credentialStore,
    oauthFetch: async () => {
      fetchCalled = true;
      return jsonResponse({});
    },
    oauthConfig: { github: { clientId: 'test-client' } },
  });
  const base = await bind(server);
  try {
    const invalidApproval = await jsonRequest(base, '/api/connectors/oauth/start', {
      method: 'POST',
      body: { id: 'github', scopes: ['read:user'], approvalId: '../bad' },
    });
    assert.equal(invalidApproval.status, 400);

    const invalidSession = await jsonRequest(base, '/api/connectors/oauth/complete', {
      method: 'POST',
      body: { id: 'github', sessionId: '../bad' },
    });
    assert.equal(invalidSession.status, 400);
    assert.equal(fetchCalled, false);
  } finally {
    await close(server);
  }
});
