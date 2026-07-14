import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AuthError } from '../src/auth/user-store.js';
import { createUserStore } from '../src/auth/user-store.js';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

type JsonRecord = Record<string, unknown>;
type JsonResponse = { status: number; body: JsonRecord | null };
type JsonRequestOptions = { method?: string; headers?: Record<string, string>; body?: unknown };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-auth-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

async function requestJson(
  base: string,
  route: string,
  opt: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const init: RequestInit = {
    method: opt.method || 'GET',
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
  };
  if (opt.body !== undefined) {
    init.body = JSON.stringify(opt.body);
  }
  const res = await fetch(`${base}${route}`, init);
  const text = await res.text();
  return { status: res.status, body: text ? requireJsonRecord(JSON.parse(text), 'response body') : null };
}

function assertStatusCode(error: unknown, expected: number): true {
  assert.ok(error && typeof error === 'object' && 'statusCode' in error);
  assert.equal((error as AuthError).statusCode, expected);
  return true;
}

test('user store: register, verify, sessions', () => {
  const store = createUserStore();
  const id = store.register('derrick', 'secret123');
  assert.match(id.userId, /^user_/);
  assert.equal(store.verify('derrick', 'secret123')?.userId, id.userId);
  assert.equal(store.verify('derrick', 'wrong'), null);
  const token = store.createSession(id);
  assert.equal(store.resolveToken(token)?.userId, id.userId);
  assert.throws(() => store.register('derrick', 'another1'), (error) => assertStatusCode(error, 409));
  assert.throws(() => store.register('x', 'short'), (error) => assertStatusCode(error, 400));
});

test('user store expires and revokes sessions after the bounded TTL', () => {
  let now = Date.parse('2026-07-10T00:00:00.000Z');
  const store = createUserStore({ sessionTtlMs: 1_000, now: () => now });
  const identity = store.register('expiryuser', 'secret123');
  const token = store.createSession(identity);
  assert.equal(store.resolveToken(token)?.userId, identity.userId);
  now += 1_001;
  assert.equal(store.resolveToken(token), null);
  assert.equal(store.logout(token), false, 'expired token is removed when resolved');
});

test('auth routes: register -> login -> me, and token sets request identity', async () => {
  const enrollmentToken = 'sample-enrollment-capability-000000000002';
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false, enrollmentToken });
  const base = await bind(server);
  try {
    const reg = await requestJson(base, '/api/auth/register', {
      method: 'POST',
      headers: { 'x-kcw-enrollment-token': enrollmentToken },
      body: { username: 'alice', password: 'hunter2x' },
    });
    assert.equal(reg.status, 200);
    const regBody = requireJsonRecord(reg.body, 'register response');
    assert.ok(typeof regBody.token === 'string' && typeof regBody.userId === 'string');

    const login = await requestJson(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'hunter2x' },
    });
    assert.equal(login.status, 200);
    const loginBody = requireJsonRecord(login.body, 'login response');
    const { token } = loginBody;
    assert.ok(typeof token === 'string');

    const me = await requestJson(base, '/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.equal(requireJsonRecord(me.body, 'me response').userId, regBody.userId);

    // token-bearing request runs as that identity (requestContext override)
    const ws = await requestJson(base, '/api/workspace', { headers: { authorization: `Bearer ${token}` } });
    const workspaceBody = requireJsonRecord(ws.body, 'workspace response');
    assert.equal(requireJsonRecord(workspaceBody.context, 'workspace context').userId, regBody.userId);

    const noAuth = await requestJson(base, '/api/auth/me');
    assert.equal(noAuth.status, 401);
    const badLogin = await requestJson(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: 'nope' },
    });
    assert.equal(badLogin.status, 401);

    const malformedRegister = await requestJson(base, '/api/auth/register', {
      method: 'POST',
      body: { username: ['alice'], password: 'hunter2x' },
    });
    assert.equal(malformedRegister.status, 400);
    const malformedLogin = await requestJson(base, '/api/auth/login', {
      method: 'POST',
      body: { username: 'alice', password: ['hunter2x'] },
    });
    assert.equal(malformedLogin.status, 400);
  } finally {
    await closeTestServer(server);
  }
});

test('auth routes: register accepts the new x-acw-enrollment-token header name', async () => {
  const enrollmentToken = 'sample-enrollment-capability-000000000003';
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false, enrollmentToken });
  const base = await bind(server);
  try {
    const rejectedLegacyHeaderName = await requestJson(base, '/api/auth/register', {
      method: 'POST',
      headers: { 'x-kcw-enrollment-token': 'wrong-token' },
      body: { username: 'bob', password: 'hunter2x' },
    });
    assert.equal(rejectedLegacyHeaderName.status, 403, 'wrong token via the legacy header name must still be rejected');

    const reg = await requestJson(base, '/api/auth/register', {
      method: 'POST',
      headers: { 'x-acw-enrollment-token': enrollmentToken },
      body: { username: 'bob', password: 'hunter2x' },
    });
    assert.equal(reg.status, 200);
    const regBody = requireJsonRecord(reg.body, 'register response');
    assert.ok(typeof regBody.token === 'string' && typeof regBody.userId === 'string');
  } finally {
    await closeTestServer(server);
  }
});
