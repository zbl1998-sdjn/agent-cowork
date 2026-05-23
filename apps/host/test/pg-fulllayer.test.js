import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CachedPostgresScheduleStore } from '../src/storage/cached-pg-schedule-store.js';
import { createServer } from '../src/server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-full-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }

test('CachedPostgresScheduleStore hydrates from PG, serves sync, writes through', async () => {
  const saved = [];
  const removed = [];
  const fakePg = {
    list: async () => [{ id: 's1', tenantId: 't1', nextFireAt: '2026-05-24T06:00:00Z' }],
    save: async (r) => { saved.push(r); return r; },
    remove: async (id) => { removed.push(id); return true; },
  };
  const store = new CachedPostgresScheduleStore({ pg: fakePg });
  await store.hydrate();
  // sync reads served from the hydrated cache
  assert.equal(store.list({}).length, 1);
  assert.equal(store.get('s1').tenantId, 't1');
  assert.equal(store.list({ tenantId: 't2' }).length, 0, 'tenant filter');
  // sync save updates cache immediately + writes through to PG
  store.save({ id: 's2', tenantId: 't1', nextFireAt: '2026-05-25T06:00:00Z' });
  assert.ok(store.get('s2'), 'cache updated synchronously');
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(saved.some((r) => r.id === 's2'), 'written through to PG');
  // remove
  assert.equal(store.remove('s1'), true);
  assert.equal(store.get('s1'), null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(removed, ['s1']);
});

test('E2E: /api/memory works with an async (Postgres-style) memory store', async () => {
  const root = tmp();
  const asyncMemory = {
    async readMainMemory() { return '# 记忆\n- **部署** (project): 用 PostgreSQL\n'; },
    async listMemoryNotes() { return [{ name: 'guide.md', size: 12, modifiedAt: '2026-05-23T00:00:00Z' }]; },
    async appendMemoryFact() { return { fact: { key: 'k', value: 'v', scope: 'project' }, file: 'postgres://x' }; },
    async writeMemoryNote() { return 'postgres://memory_notes/n1'; },
    async readMemoryNote() { return '# 指南'; },
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, memoryStore: asyncMemory });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/memory`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.memory.text, /部署/, 'async readMainMemory awaited (not a Promise)');
    assert.equal(body.memory.notes.length, 1);
    assert.equal(body.memory.notes[0].name, 'guide.md');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
