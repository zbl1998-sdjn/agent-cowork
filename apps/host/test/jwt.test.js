import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signJwtHS256, verifyJwtHS256, resolveJwtIdentity } from '../src/auth/jwt.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-jwt-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
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
  assert.deepEqual(resolveJwtIdentity(signJwtHS256({ tenant_id: 'acme', user_id: 'u1' }, SECRET), SECRET).tenantId, 'acme');
  assert.equal(resolveJwtIdentity(signJwtHS256({ tid: 'org9', sub: 'u2' }, SECRET), SECRET).tenantId, 'org9');
  assert.equal(resolveJwtIdentity(signJwtHS256({ sub: 'u3' }, SECRET), SECRET).userId, 'u3');
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
  } finally { await new Promise((r) => server.close(r)); }
});
