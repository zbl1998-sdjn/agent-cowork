import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-async-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

// Proves the run-routes read path awaits the index, so the async PostgreSQL
// adapter (and any Promise-returning repository) works through HTTP.
test('E2E: /api/runs/index works with an async (Postgres-style) runsIndex', async () => {
  const root = tmp();
  let listArgs = null;
  const asyncIndex = {
    async list(args) { listArgs = args; return [{ id: 'run_x', tenantId: 'tenant_local', type: 'agent-chat', status: 'succeeded' }]; },
    async stats() { return { total: 1, byStatus: { succeeded: 1 }, byType: { 'agent-chat': 1 } }; },
    async get() { return null; },
    async upsert(rec) { return rec; },
    async remove() { return false; },
    async size() { return 1; },
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, runsIndex: asyncIndex });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/index?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.runs) && body.runs.some((r) => r.id === 'run_x'), 'async list surfaced through HTTP (not a Promise)');
    assert.equal(body.stats.total, 1);
    assert.equal(listArgs.tenantId, 'tenant_local', 'tenant scoping passed to the async adapter');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
