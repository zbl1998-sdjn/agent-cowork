import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-pgw-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('storeBackend=postgres starts the PG approval store + event bus LISTEN connections', async () => {
  const root = tmp();
  let aStarted = 0;
  let eStarted = 0;
  const approvalRegistry = {
    start: async () => { aStarted += 1; },
    request: () => ({ id: 'x', promise: Promise.resolve('once') }),
    resolve: async () => true, respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const runEventBus = {
    start: async () => { eStarted += 1; },
    publish: () => {}, subscribe: () => (() => {}), replay: () => [], subscriberCount: () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, storeBackend: 'postgres', databaseUrl: 'postgres://example/db', approvalRegistry, runEventBus });
  await new Promise((r) => setTimeout(r, 20));
  try {
    assert.equal(aStarted, 1, 'approval store LISTEN started');
    assert.equal(eStarted, 1, 'event bus LISTEN started');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('file backend does NOT start LISTEN (single-instance default)', async () => {
  const root = tmp();
  let started = 0;
  const approvalRegistry = {
    start: async () => { started += 1; },
    request: () => ({ id: 'x', promise: Promise.resolve('once') }),
    resolve: async () => true, respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  await new Promise((r) => setTimeout(r, 20));
  try {
    assert.equal(started, 0, 'no LISTEN in file mode');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('POST /api/approvals/:id awaits an async resolve (PG-style store)', async () => {
  const root = tmp();
  let resolvedWith = null;
  const approvalRegistry = {
    request: () => ({ id: 'x', promise: Promise.resolve('once') }),
    resolve: async (id, decision) => { resolvedWith = { id, decision }; return true; },
    respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/approvals/apr_123`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'once' }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, 'awaited async resolve returned true');
    assert.deepEqual(resolvedWith, { id: 'apr_123', decision: 'once' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
