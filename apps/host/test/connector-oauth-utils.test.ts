import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOAuthScopes, oauthPermissions, selectedOAuthPermissions } from '../src/connectors/oauth-permissions.js';
import { createConnectorOAuthSession } from '../src/routes/connector-oauth-session.js';
import { sendConnectorOAuthStatus, unsupportedOAuthConnector } from '../src/routes/connector-oauth-status.js';
import {
  GITHUB_CLIENT_ID_ENV_KEYS,
  errorStatus,
  githubClientId,
  githubConnector,
  isGitHub,
  oauthFilter,
  oauthIdentity,
} from '../src/routes/connector-oauth-route-utils.js';
import type { CredentialStore } from '../src/security/credential-store.js';

class CapturingJsonResponse {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = '';

  writeHead(statusCode: number, headers: Record<string, string | number> = {}): void {
    this.statusCode = statusCode;
    this.headers = { ...headers };
  }

  end(chunk: string | Buffer = ''): void {
    this.body += String(chunk);
  }

  json(): Record<string, unknown> {
    const parsed = JSON.parse(this.body) as unknown;
    assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'response should be a JSON object');
    return parsed as Record<string, unknown>;
  }
}

test('OAuth route utilities normalize identities, client id, and status codes', () => {
  const previousClientId = process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
  process.env.KCW_GITHUB_OAUTH_CLIENT_ID = 'env-client-id';
  try {
    assert.equal(isGitHub('GitHub'), true);
    assert.equal(githubClientId({ github: { clientId: ['bad-client'] } }), 'env-client-id');
    assert.deepEqual(oauthIdentity({ tenantId: 'tenant-a', userId: 'user-a' }, 'github', 'octocat'), {
      tenantId: 'tenant-a',
      userId: 'user-a',
      provider: 'github',
      accountId: 'octocat',
    });
    const noisyContext = { tenantId: 123, userId: 'user-a' } as unknown as Parameters<typeof oauthFilter>[0];
    assert.throws(() => oauthFilter(noisyContext, 'github'), /canonical tenantId and userId are required/i);
    assert.throws(() => oauthIdentity({ tenantId: 'tenant-a' }, 'github'), /canonical tenantId and userId are required/i);
    assert.throws(
      () => oauthIdentity({ tenantId: 'tenant-a', userId: 'user-a' }, ' github'),
      /credential provider/i,
    );
    assert.equal(githubConnector().id, 'github');
    assert.equal(errorStatus({ statusCode: 418 }, 502), 418);
    assert.equal(errorStatus({ statusCode: '418' }, 502), 502);
  } finally {
    if (previousClientId === undefined) delete process.env.KCW_GITHUB_OAUTH_CLIENT_ID;
    else process.env.KCW_GITHUB_OAUTH_CLIENT_ID = previousClientId;
  }
});

test('OAuth permissions normalize defaults, risks, and selected scopes without granting unknown scopes', () => {
  const connector = {
    auth: {
      permissions: [
        { id: 'read:user', label: 'Read user', description: 'Read profile', risk: 'LOW' },
        { id: 'repo', label: 'Repo', description: 'Repository access', risk: 'HIGH', default: false },
        { id: '  ', label: 'blank' },
      ],
    },
  };

  assert.deepEqual(oauthPermissions(connector), [
    { id: 'read:user', label: 'Read user', description: 'Read profile', risk: 'low', default: true },
    { id: 'repo', label: 'Repo', description: 'Repository access', risk: 'high', default: false },
  ]);
  assert.deepEqual(normalizeOAuthScopes(connector, undefined), ['read:user']);
  assert.deepEqual(normalizeOAuthScopes(connector, 'repo read:user'), ['read:user', 'repo']);
  assert.deepEqual(selectedOAuthPermissions(connector, ['repo']), [
    { id: 'repo', label: 'Repo', description: 'Repository access', risk: 'high', default: false },
  ]);
  assert.throws(
    () => normalizeOAuthScopes(connector, ['admin:org']),
    (error: unknown) => error instanceof Error
      && /unsupported OAuth scope: admin:org/.test(error.message)
      && (error as { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => normalizeOAuthScopes({ auth: { permissions: [{ id: 'repo', default: false }] } }, undefined),
    (error: unknown) => error instanceof Error
      && /at least one OAuth scope is required/.test(error.message)
      && (error as { statusCode?: number }).statusCode === 400,
  );
});

test('OAuth permissions fall back to connector scopes when no explicit permissions are declared', () => {
  const connector = { auth: { scopes: ['read:user', 'user:email'] } };

  assert.deepEqual(oauthPermissions(connector), [
    { id: 'read:user', label: 'read:user', description: '', risk: 'low', default: true },
    { id: 'user:email', label: 'user:email', description: '', risk: 'low', default: true },
  ]);
  assert.deepEqual(normalizeOAuthScopes(connector, 'user:email'), ['user:email']);
});

test('OAuth session creation binds GitHub device sessions to the request identity', () => {
  assert.deepEqual(createConnectorOAuthSession({
    clientId: 'client-id',
    deviceCode: 'device-code',
    scopes: ['read:user', 'repo'],
    permissions: [{ id: 'github:profile', label: 'Profile', description: 'Read profile', risk: 'low', default: true }],
    requestContext: { tenantId: 'tenant-a', userId: 'user-a' },
    expiresAtMs: 123456,
  }), {
    provider: 'github',
    clientId: 'client-id',
    deviceCode: 'device-code',
    scopes: ['read:user', 'repo'],
    permissions: [{ id: 'github:profile', label: 'Profile', description: 'Read profile', risk: 'low', default: true }],
    tenantId: 'tenant-a',
    userId: 'user-a',
    expiresAtMs: 123456,
  });

  assert.throws(() => createConnectorOAuthSession({
    clientId: 'client-id',
    deviceCode: 'device-code',
    scopes: [],
    permissions: [],
    requestContext: {},
    expiresAtMs: 1,
  }), /canonical tenantId and userId are required/i);
});

test('OAuth status returns scoped account summaries and configuration hints without secrets', () => {
  const response = new CapturingJsonResponse();
  const listCalls: unknown[] = [];
  const accounts = [{
    provider: 'github',
    accountId: 'octocat',
    tenantId: 'tenant-a',
    userId: 'user-a',
    scopes: ['read:user'],
    account: { login: 'octocat' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }];
  const credentialStore = {
    list(filter?: unknown) {
      listCalls.push(filter);
      return accounts;
    },
  } as unknown as CredentialStore;

  sendConnectorOAuthStatus({
    response,
    requestUrl: new URL('http://127.0.0.1/api/connectors/oauth/status?provider=github'),
    requestContext: { tenantId: 'tenant-a', userId: 'user-a' },
    credentialStore,
    oauthConfig: { github: { clientId: 'configured-client-id' } },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(listCalls, [{ tenantId: 'tenant-a', userId: 'user-a', provider: 'github' }]);
  assert.equal(body.provider, 'github');
  assert.equal(body.connected, true);
  assert.equal(body.configured, true);
  assert.equal(body.configurationMessage, 'GitHub OAuth client id 已配置。');
  assert.deepEqual(body.requiredEnv, GITHUB_CLIENT_ID_ENV_KEYS);
  assert.deepEqual(body.accounts, [{
    provider: 'github',
    accountId: 'octocat',
    tenantId: 'tenant-a',
    userId: 'user-a',
    scopes: ['read:user'],
    account: { login: 'octocat' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.ok(Array.isArray(body.permissions));
  assert.equal(response.body.includes('configured-client-id'), false);
});

test('OAuth status drops over-specified credential summaries instead of leaking fields', () => {
  const response = new CapturingJsonResponse();
  const credentialStore = {
    list() {
      return [{
        provider: 'github',
        accountId: 'octocat',
        tenantId: 'tenant-a',
        userId: 'user-a',
        scopes: ['read:user'],
        account: { login: 'octocat' },
        updatedAt: '2026-01-01T00:00:00.000Z',
        accessToken: 'test-secret-marker',
      }];
    },
  } as unknown as CredentialStore;

  sendConnectorOAuthStatus({
    response,
    requestUrl: new URL('http://127.0.0.1/api/connectors/oauth/status?id=github'),
    requestContext: { tenantId: 'tenant-a', userId: 'user-a' },
    credentialStore,
  });

  const body = response.json();
  assert.equal(body.connected, false);
  assert.deepEqual(body.accounts, []);
  assert.equal(response.body.includes('test-secret-marker'), false);
});

test('OAuth status fails closed for unsupported connectors or missing credential store', () => {
  const missingStore = new CapturingJsonResponse();
  sendConnectorOAuthStatus({
    response: missingStore,
    requestUrl: new URL('http://127.0.0.1/api/connectors/oauth/status?id=github'),
    requestContext: {},
  });
  assert.equal(missingStore.statusCode, 400);
  assert.deepEqual(missingStore.json(), { error: 'unsupported OAuth connector' });

  const unsupported = new CapturingJsonResponse();
  unsupportedOAuthConnector(unsupported);
  assert.equal(unsupported.statusCode, 400);
  assert.deepEqual(unsupported.json(), { error: 'unsupported OAuth connector' });
});
