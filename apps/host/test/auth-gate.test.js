import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer(config); // requireAuth defaults ON
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
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

test('new file and route surfaces are covered by the auth gate', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-surfaces');
  await withServer({ trustedRoot, requireAuth: true, trustIdentityHeaders: false }, async (base) => {
    const routes = [
      ['/api/workspace/search', { method: 'POST', body: { trustedRoot, query: 'alpha' } }],
      ['/api/file-ops/preview', { method: 'POST', body: { trustedRoot, operations: [] } }],
      ['/api/conversations', { method: 'GET' }],
      ['/api/conversations/branch-test', { method: 'PUT', body: { trustedRoot, title: 'x', branches: [] } }],
      ['/api/artifacts', { method: 'GET' }],
      ['/api/artifacts/rename', { method: 'POST', headers: { 'idempotency-key': 'rename-gate' }, body: { trustedRoot, path: 'x.md', newName: 'y.md' } }],
      ['/api/viz/render', { method: 'POST', headers: { 'idempotency-key': 'viz-gate' }, body: { trustedRoot, kind: 'table', data: { columns: ['a'], rows: [[1]] } } }],
      ['/api/prompt/refine', { method: 'POST', body: { trustedRoot, prompt: '改一下' } }],
      ['/api/runtime/dependencies', { method: 'GET' }],
      ['/api/runtime/dependencies/install-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
      ['/api/runtime/dependencies/cleanup-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
      ['/api/runtime/dependencies/update-plan', { method: 'POST', body: { selectedIds: ['data-science'] } }],
    ];

    for (const [route, options] of routes) {
      const response = await fetch(`${base}${route}`, {
        method: options.method,
        headers: {
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
      assert.equal(response.status, 401, `${options.method} ${route} should require auth`);
    }
  });
});

test('public auth routes work without a token, and the token then unlocks /api', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-2');
  await withServer({ trustedRoot, requireAuth: true }, async (base) => {
    const reg = await (await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'gateuser', password: 'passw0rd' }),
    })).json();
    assert.ok(reg.token, 'register returns a token');
    const ok = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${reg.token}` } });
    assert.equal(ok.status, 200);
  });
});

test('guest endpoint mints an isolated token that passes the gate', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-guest');
  await withServer({ trustedRoot, requireAuth: true }, async (base) => {
    const guest = await (await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.ok(guest.token, 'guest returns a token');
    assert.match(guest.tenantId, /^tenant_guest_/, 'guest gets its own tenant');
    const ok = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${guest.token}` } });
    assert.equal(ok.status, 200);
  });
});

test('requireAuth:false disables the gate (functional-test mode)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-authgate-off');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    assert.equal((await fetch(`${base}/api/workspace`)).status, 200);
  });
});
