import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:http';
import { createServer, type ServerConfig } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { recordValue, stringField } from './helpers/host-http.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { createUserStore } from '../src/auth/user-store.js';

type AuthRouteOptions = {
  method: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  headers?: Record<string, string>;
};

type AuthRouteCase = readonly [route: string, options: AuthRouteOptions];

async function withServer(config: ServerConfig, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(config); // requireAuth defaults ON
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'auth gate test server should bind to a TCP port');
  const { port } = address as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await closeTestServer(server);
  }
}

test('unauthenticated /api is blocked; spoofed identity headers do not authenticate', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate');
  // Force the gate semantics regardless of the suite-wide identity-header preload.
  await withServer({ trustedRoot, requireAuth: true, trustIdentityHeaders: false }, async (base) => {
    // /health is exempt (monitoring).
    assert.equal((await fetch(`${base}/health`)).status, 200);
    // Unauthenticated API access is rejected.
    assert.equal((await fetch(`${base}/api/workspace`)).status, 401);
    assert.equal((await fetch(`${base}/api/runs/index`)).status, 401);
    // A spoofed x-tenant-id / x-user-id MUST NOT grant access.
    const spoof = await fetch(`${base}/api/workspace`, { headers: { 'x-tenant-id': 'tenant_evil', 'x-user-id': 'admin' } });
    assert.equal(spoof.status, 401, 'client identity headers must not authenticate');
    // An unauthenticated write is rejected too.
    const write = await fetch(`${base}/api/file-ops/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operations: [{ type: 'write', path: 'x.txt', content: 'hi' }] }),
    });
    assert.equal(write.status, 401);
  });
});

test('trusted identity headers require a complete valid tenant and user pair', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-trusted-pair');
  await withServer({ trustedRoot, requireAuth: true, trustIdentityHeaders: true }, async (base) => {
    const incompleteCases: ReadonlyArray<readonly [string, Record<string, string>]> = [
      ['no identity headers', {}],
      ['tenant only', { 'x-tenant-id': 'tenant_trusted' }],
      ['user only', { 'x-user-id': 'user_trusted' }],
      ['invalid tenant', { 'x-tenant-id': 'tenant invalid', 'x-user-id': 'user_trusted' }],
      ['invalid user', { 'x-tenant-id': 'tenant_trusted', 'x-user-id': 'user invalid' }],
    ];

    for (const [label, headers] of incompleteCases) {
      const response = await fetch(`${base}/api/workspace`, { headers });
      assert.equal(response.status, 401, `${label} must not authenticate`);
      assert.equal(response.headers.get('x-tenant-id'), 'tenant_local', `${label} must not partially override tenant`);
      assert.equal(response.headers.get('x-user-id'), 'user_local', `${label} must not partially override user`);
    }

    const complete = await fetch(`${base}/api/workspace`, {
      headers: { 'x-tenant-id': 'tenant_trusted', 'x-user-id': 'user_trusted' },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.headers.get('x-tenant-id'), 'tenant_trusted');
    assert.equal(complete.headers.get('x-user-id'), 'user_trusted');
  });
});

test('new file and route surfaces are covered by the auth gate', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-surfaces');
  await withServer({ trustedRoot, requireAuth: true, trustIdentityHeaders: false }, async (base) => {
    const routes: AuthRouteCase[] = [
      ['/api/workspace/search', { method: 'POST', body: { trustedRoot, query: 'alpha' } }],
      ['/api/file-ops/preview', { method: 'POST', body: { trustedRoot, operations: [] } }],
      ['/api/conversations', { method: 'GET' }],
      ['/api/conversations/branch-test', { method: 'PUT', body: { trustedRoot, title: 'x', branches: [] } }],
      ['/api/artifacts', { method: 'GET' }],
      ['/api/artifacts/rename', { method: 'POST', headers: { 'idempotency-key': 'rename-gate' }, body: { trustedRoot, path: 'x.md', newName: 'y.md' } }],
      ['/api/viz/render/preview', { method: 'POST', body: { trustedRoot, kind: 'table', data: { columns: ['a'], rows: [[1]] } } }],
      ['/api/viz/render', { method: 'POST', headers: { 'idempotency-key': 'viz-gate' }, body: { trustedRoot, kind: 'table', data: { columns: ['a'], rows: [[1]] } } }],
      ['/api/prompt/refine', { method: 'POST', body: { trustedRoot, prompt: '改一下' } }],
      ['/api/runtime/dependencies', { method: 'GET' }],
      ['/api/runtime/dependencies/install-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
      ['/api/runtime/dependencies/cleanup-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
      ['/api/runtime/dependencies/update-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
      ['/api/capabilities/catalog', { method: 'GET' }],
      ['/api/capabilities/recommend?role=developer', { method: 'GET' }],
      ['/api/install/plan', { method: 'POST', body: { packIds: ['frontend-design-pack'] } }],
      ['/api/capabilities/install-plan', { method: 'POST', body: { packIds: ['frontend-design-pack'] } }],
      ['/api/fallback/status', { method: 'GET' }],
    ];

    for (const [route, options] of routes) {
      const init: RequestInit = {
        method: options.method,
        headers: {
          ...(options.body == null ? {} : { 'content-type': 'application/json' }),
          ...(options.headers ?? {}),
        },
      };
      if (options.body != null) {
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(`${base}${route}`, init);
      assert.equal(response.status, 401, `${options.method} ${route} should require auth`);
    }
  });
});

test('registration is default-closed and a valid enrollment capability is consumed once', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-2');
  const authStore = createUserStore();
  const enrollmentToken = 'sample-enrollment-capability-000000000001';
  await withServer({ trustedRoot, requireAuth: true, authStore, enrollmentToken }, async (base) => {
    const denied = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gateuser', password: 'passw0rd' }),
    });
    assert.equal(denied.status, 403);
    assert.equal(authStore.count(), 0, 'denied enrollment must not create a user');

    const registerResponse = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kcw-enrollment-token': enrollmentToken },
      body: JSON.stringify({ username: 'gateuser', password: 'passw0rd' }),
    });
    const reg = recordValue(await registerResponse.json(), 'register response');
    const token = stringField(reg, 'token');
    assert.ok(token, 'register returns a token');
    const ok = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);

    const replay = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kcw-enrollment-token': enrollmentToken },
      body: '{}',
    });
    assert.equal(replay.status, 403, 'enrollment capability must be single-use');
  });
});

test('guest enrollment is default-closed without an enrollment capability', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-guest');
  await withServer({ trustedRoot, requireAuth: true }, async (base) => {
    const guestResponse = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(guestResponse.status, 403);
  });
});

test('explicit safe local desktop guest bootstrap creates an authenticated isolated guest', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-local-guest');
  await withServer({
    trustedRoot,
    requireAuth: true,
    trustIdentityHeaders: false,
    validateHost: true,
    allowLocalGuestEnrollment: true,
  }, async (base) => {
    const guestResponse = await fetch(`${base}/api/auth/guest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(guestResponse.status, 200);
    const guest = recordValue(await guestResponse.json(), 'guest response');
    const token = stringField(guest, 'token');
    assert.ok(token, 'guest bootstrap returns a session token');
    assert.equal((await fetch(`${base}/api/workspace`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);

    const registerResponse = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'local-user', password: 'passw0rd' }),
    });
    assert.equal(registerResponse.status, 403, 'local guest bootstrap must not open user registration');
  });
});

test('local guest bootstrap flag is ignored outside the safe desktop boundary', async () => {
  const cases: ReadonlyArray<readonly [string, Partial<ServerConfig>]> = [
    ['authentication disabled', { requireAuth: false, trustIdentityHeaders: false, validateHost: true }],
    ['trusted identity headers enabled', { requireAuth: true, trustIdentityHeaders: true, validateHost: true }],
    ['host validation disabled', { requireAuth: true, trustIdentityHeaders: false, validateHost: false }],
  ];

  for (const [label, config] of cases) {
    const trustedRoot = makeTestWorkspace(`kcw-authgate-local-guest-${label.replaceAll(' ', '-')}`);
    await withServer({ trustedRoot, allowLocalGuestEnrollment: true, ...config }, async (base) => {
      const response = await fetch(`${base}/api/auth/guest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 403, label);
    });
  }
});

test('requireAuth:false disables the gate (functional-test mode)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-off');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    assert.equal((await fetch(`${base}/api/workspace`)).status, 200);
  });
});
