import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConcurrencyLimiter } from '../src/runtime/concurrency.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-conc-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('limiter caps per-tenant and global; release frees slots', () => {
  const lim = createConcurrencyLimiter({ maxConcurrent: 3, maxPerTenant: 2 });
  const a = lim.tryAcquire('t1');
  const b = lim.tryAcquire('t1');
  assert.ok(a && b, 'two for t1');
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
  r(); r();
  assert.equal(lim.stats().active, 0);
  assert.ok(lim.tryAcquire('t1'), 'capacity restored');
});

test('E2E: agent stream returns 429 when the limiter is full', async () => {
  const root = tmp();
  const agentConcurrency = { tryAcquire: () => null, stats: () => ({}) };
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall: async () => ({ content: 'hi' }), agentConcurrency });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.match(body.error, /并发/);
  } finally { if (server.closeMcp) server.closeMcp(); await new Promise((r) => server.close(r)); }
});

test('E2E: a normal run acquires then releases its slot (capacity restored)', async () => {
  const root = tmp();
  const lim = createConcurrencyLimiter({ maxConcurrent: 2, maxPerTenant: 2 });
  const server = createServer({ requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: async () => ({}), agentModelCall: async () => ({ content: '完成。' }), agentConcurrency: lim });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/agent/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) });
    assert.equal(res.status, 200);
    await res.text();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(lim.stats().active, 0, 'slot released after the run finished');
  } finally { if (server.closeMcp) server.closeMcp(); await new Promise((r) => server.close(r)); }
});
