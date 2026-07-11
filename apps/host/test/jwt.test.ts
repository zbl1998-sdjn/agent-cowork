import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signJwtHS256, verifyJwtHS256, resolveJwtIdentity } from '../src/auth/jwt.js';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jwt-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

const SECRET = 'test-secret-123';

test('sign + verify round-trips and exposes claims', () => {
  const token = signJwtHS256({ tenant_id: 'acme', sub: 'u-7', role: 'admin' }, SECRET, { expiresInSec: 3600 });
  const payload = verifyJwtHS256(token, SECRET);
  assert.ok(payload);
  assert.equal(payload.tenant_id, 'acme');
  assert.equal(payload.sub, 'u-7');
});

test('tampered or wrong-secret tokens are rejected', () => {
  const token = signJwtHS256({ sub: 'u-7' }, SECRET);
  assert.equal(verifyJwtHS256(token, 'wrong-secret'), null, 'wrong secret rejected');
  const parts = token.split('.');
  const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
  assert.equal(verifyJwtHS256(tampered, SECRET), null, 'tampered payload rejected');
  assert.equal(verifyJwtHS256('not-a-jwt', SECRET), null);
});

test('expired tokens are rejected', () => {
  const token = signJwtHS256({ sub: 'u-7', exp: Math.floor(Date.now() / 1000) - 100 }, SECRET);
  assert.equal(verifyJwtHS256(token, SECRET), null, 'expired rejected (beyond clock tolerance)');
});

test('resolveJwtIdentity maps common claim names', () => {
  assert.equal(resolveJwtIdentity(signJwtHS256({ tenant_id: 'acme', user_id: 'u1' }, SECRET), SECRET)?.tenantId, 'acme');
  assert.equal(resolveJwtIdentity(signJwtHS256({ tid: 'org9', sub: 'u2' }, SECRET), SECRET)?.tenantId, 'org9');
  assert.equal(resolveJwtIdentity(signJwtHS256({ sub: 'u3' }, SECRET), SECRET), null);
  assert.equal(resolveJwtIdentity(signJwtHS256({ tenant_id: 'acme' }, SECRET), SECRET), null);
  assert.equal(resolveJwtIdentity('garbage', SECRET), null);
});

test('E2E: a valid JWT sets the request context tenant/user (echoed in response headers)', async () => {
  const root = tmp();
  const server = createServer({ trustedRoot: root, enableScheduler: false, jwtSecret: SECRET });
  const base = await bind(server);
  try {
    const token = signJwtHS256({ tenant_id: 'tenant-xyz', user_id: 'user-abc' }, SECRET, { expiresInSec: 600 });
    const res = await fetch(`${base}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.headers.get('x-tenant-id'), 'tenant-xyz');
    assert.equal(res.headers.get('x-user-id'), 'user-abc');
    // a request without a token keeps the local defaults
    const res2 = await fetch(`${base}/api/workspace`);
    assert.equal(res2.headers.get('x-tenant-id'), 'tenant_local');
  } finally {
    await closeTestServer(server);
  }
});

test('E2E: trusted JWTs missing either owner claim are rejected without mixed local identity', async () => {
  const root = tmp();
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    persistAuth: false,
    requireAuth: true,
    jwtSecret: SECRET,
    trustIdentityHeaders: false,
  });
  const base = await bind(server);
  try {
    for (const claims of [
      { tenant_id: 'tenant-only' },
      { user_id: 'user-only' },
    ]) {
      const token = signJwtHS256(claims, SECRET, { expiresInSec: 600 });
      const response = await fetch(`${base}/api/workspace`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('x-tenant-id'), 'tenant_local');
      assert.equal(response.headers.get('x-user-id'), 'user_local');
    }

    const complete = signJwtHS256(
      { tenant_id: 'tenant-complete', user_id: 'user-complete' },
      SECRET,
      { expiresInSec: 600 },
    );
    const response = await fetch(`${base}/api/workspace`, {
      headers: { authorization: `Bearer ${complete}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-tenant-id'), 'tenant-complete');
    assert.equal(response.headers.get('x-user-id'), 'user-complete');
  } finally {
    await closeTestServer(server);
  }
});
