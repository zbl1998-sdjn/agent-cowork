import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserStore } from '../src/auth/user-store.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-auth-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { method: opt.method || 'GET', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('user store: register, verify, sessions', () => {
  const store = createUserStore();
  const id = store.register('derrick', 'secret123');
  assert.match(id.userId, /^user_/);
  assert.equal(store.verify('derrick', 'secret123').userId, id.userId);
  assert.equal(store.verify('derrick', 'wrong'), null);
  const token = store.createSession(id);
  assert.equal(store.resolveToken(token).userId, id.userId);
  assert.throws(() => store.register('derrick', 'another1'), (e) => { assert.equal(e.statusCode, 409); return true; });
  assert.throws(() => store.register('x', 'short'), (e) => { assert.equal(e.statusCode, 400); return true; });
});

test('auth routes: register -> login -> me, and token sets request identity', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const reg = await J(base, '/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'hunter2x' } });
    assert.equal(reg.status, 200);
    assert.ok(reg.body.token && reg.body.userId);

    const login = await J(base, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'hunter2x' } });
    assert.equal(login.status, 200);
    const token = login.body.token;

    const me = await J(base, '/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.body.userId, reg.body.userId);

    // token-bearing request runs as that identity (requestContext override)
    const ws = await J(base, '/api/workspace', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ws.body.context.userId, reg.body.userId);

    const noAuth = await J(base, '/api/auth/me');
    assert.equal(noAuth.status, 401);
    const badLogin = await J(base, '/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'nope' } });
    assert.equal(badLogin.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
