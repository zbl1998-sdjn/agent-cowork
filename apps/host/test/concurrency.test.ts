import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ModelTextResult } from '../src/engine/api-runner.js';
import type { ConcurrencyLimiter } from '../src/runtime/concurrency.js';
import { createConcurrencyLimiter } from '../src/runtime/concurrency.js';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

type JsonRecord = Record<string, unknown>;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-conc-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as JsonRecord;
}

async function fakeKimiChatRunner(): Promise<ModelTextResult> {
  return { ok: true, provider: 'test', model: 'test', mode: 'chat', text: 'ok', durationMs: 0 };
}

test('limiter caps per-tenant and global; release frees slots', () => {
  const lim = createConcurrencyLimiter({ maxConcurrent: 3, maxPerTenant: 2 });
  const a = lim.tryAcquire('t1');
  const b = lim.tryAcquire('t1');
  assert.ok(a, 'first t1 slot');
  assert.ok(b, 'second t1 slot');
  assert.equal(lim.tryAcquire('t1'), null, 'per-tenant cap hit');
  const c = lim.tryAcquire('t2');
  assert.ok(c, 'other tenant still allowed');
  assert.equal(lim.stats().active, 3);
  assert.equal(lim.tryAcquire('t2'), null, 'global cap hit');
  a();
  assert.ok(lim.tryAcquire('t1'), 'slot freed after release');
});

test('release is idempotent and never drives counts negative', () => {
  const lim = createConcurrencyLimiter({ maxConcurrent: 1, maxPerTenant: 1 });
  const r = lim.tryAcquire('t1');
  assert.ok(r);
  r();
  r();
  assert.equal(lim.stats().active, 0);
  assert.ok(lim.tryAcquire('t1'), 'capacity restored');
});

test('E2E: agent stream returns 429 when the limiter is full', async () => {
  const root = tmp();
  const agentConcurrency: ConcurrencyLimiter = {
    tryAcquire: () => null,
    stats: () => ({ active: 0, tenants: 0, maxConcurrent: 0, maxPerTenant: 0 }),
  };
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    modelChatRunner: fakeKimiChatRunner,
    agentModelCall: async () => ({ content: 'hi' }),
    agentConcurrency,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(res.status, 429);
    const body = requireJsonRecord(await res.json(), '429 response');
    const errorMessage = body.error;
    if (typeof errorMessage !== 'string') throw new TypeError('429 response.error must be a string');
    assert.match(errorMessage, /并发/);
  } finally {
    await closeTestServer(server);
  }
});

test('E2E: a normal run acquires then releases its slot (capacity restored)', async () => {
  const root = tmp();
  const lim = createConcurrencyLimiter({ maxConcurrent: 2, maxPerTenant: 2 });
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    requireAuth: false,
    trustedRoot: root,
    enableScheduler: false,
    modelChatRunner: fakeKimiChatRunner,
    agentModelCall: async () => ({ content: '完成。' }),
    agentConcurrency: lim,
  });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lim.stats().active, 0, 'slot released after the run finished');
  } finally {
    await closeTestServer(server);
  }
});
