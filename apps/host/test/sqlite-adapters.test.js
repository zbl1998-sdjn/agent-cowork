import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SqliteMemoryStore } from '../src/memory/memory-store.js';
import { SqliteRunsIndex, createUlid } from '../src/runtime/runs-index.js';
import { Scheduler, SqliteScheduleStore } from '../src/runtime/scheduler.js';
import { createServer } from '../src/server.js';

const require = createRequire(import.meta.url);

function hasNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const sqliteAvailable = hasNodeSqlite();

function tempRoot(prefix = 'kcw-sqlite-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

test('SqliteRunsIndex matches file adapter semantics for upsert/list/stats/remove', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'state.sqlite');
  const index = new SqliteRunsIndex({ dbPath });
  const id = createUlid();

  index.upsert({
    id,
    tenantId: 'tenant_alice',
    userId: 'user_alice',
    traceId: 'trace_1',
    type: 'recipe-run',
    status: 'running',
    recipeId: 'meeting-actions',
    startedAt: '2026-05-20T10:00:00Z',
  });
  index.upsert({
    id,
    tenantId: 'tenant_alice',
    userId: 'user_alice',
    type: 'recipe-run',
    status: 'succeeded',
    recipeId: 'meeting-actions',
    startedAt: '2026-05-20T10:00:00Z',
    finishedAt: '2026-05-20T10:00:01Z',
  });

  const got = index.get(id, { tenantId: 'tenant_alice' });
  assert.equal(got.status, 'succeeded');
  assert.equal(got.version, 2);
  assert.equal(index.get(id, { tenantId: 'tenant_bob' }), null);
  assert.deepEqual(index.list({ tenantId: 'tenant_alice' }).map((record) => record.id), [id]);
  assert.equal(index.stats({ tenantId: 'tenant_alice' }).total, 1);

  const reopened = new SqliteRunsIndex({ dbPath });
  assert.equal(reopened.get(id).status, 'succeeded');
  assert.equal(reopened.remove(id), true);
  assert.equal(reopened.size(), 0);
});

test('SqliteMemoryStore stores tenant-scoped facts and notes', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'state.sqlite');
  const store = new SqliteMemoryStore({ dbPath });

  const fact = store.appendMemoryFact(
    root,
    { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营', scope: 'project' },
    { tenantId: 'tenant_alice', userId: 'user_alice', traceId: 'trace_1' },
  );
  assert.equal(fact.fact.key, '客户简称');
  assert.match(fact.file, /^sqlite:\/\/memory_facts\//);

  store.appendMemoryFact(root, { key: '隔离', value: '不应泄漏' }, { tenantId: 'tenant_bob' });
  const body = store.readMainMemory(root, { tenantId: 'tenant_alice' });
  assert.match(body, /客户简称/);
  assert.doesNotMatch(body, /不应泄漏/);

  const notePath = store.writeMemoryNote(
    root,
    'projects.md',
    '# Projects\n- Alpha\n',
    { tenantId: 'tenant_alice', userId: 'user_alice' },
  );
  assert.match(notePath, /^sqlite:\/\/memory_notes\//);
  assert.match(store.readMemoryNote(root, 'projects.md', { tenantId: 'tenant_alice' }), /Alpha/);
  assert.equal(store.listMemoryNotes(root, { tenantId: 'tenant_alice' }).length, 1);
  assert.equal(store.loadMemoryContext(root, { context: { tenantId: 'tenant_alice' } }).enabled, true);
});

test('SqliteScheduleStore persists schedules across Scheduler instances', { skip: !sqliteAvailable }, async () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'state.sqlite');
  let nowMs = new Date('2026-05-18T08:59:00').getTime();
  const fired = [];
  const scheduler = new Scheduler({
    store: new SqliteScheduleStore({ dbPath }),
    executor: async (record) => {
      fired.push(record.id);
      return { runId: `run_${record.id}` };
    },
    now: () => new Date(nowMs),
  });

  const record = scheduler.create({
    name: 'weekly',
    cron: '0 9 * * 1',
    tenantId: 'tenant_alice',
    userId: 'user_alice',
  });
  assert.match(record.id, /^sched_/);
  assert.equal(scheduler.list({ tenantId: 'tenant_alice' }).length, 1);

  nowMs = Date.parse(record.nextFireAt) + 1000;
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(fired.length, 1);

  const reopened = new Scheduler({
    store: new SqliteScheduleStore({ dbPath }),
    executor: async () => ({ runId: 'unused' }),
    now: () => new Date(nowMs),
  });
  const after = reopened.get(record.id);
  assert.equal(after.runs, 1);
  assert.equal(after.lastRunId, `run_${record.id}`);
});

test('server storeBackend=sqlite wires memory, runs index, and schedules', { skip: !sqliteAvailable }, async () => {
  const trustedRoot = tempRoot();
  const dbPath = path.join(trustedRoot, '.KimiCowork', 'state.sqlite');
  const server = createServer({
    trustedRoot,
    storeBackend: 'sqlite',
    sqliteDbPath: dbPath,
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' };
    const fact = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      headers,
      body: { key: '术语', value: 'OKR = Objectives and Key Results' },
    });
    assert.equal(fact.status, 200);

    const memory = await jsonRequest(base, '/api/memory', { headers });
    assert.equal(memory.status, 200);
    assert.match(memory.body.memory.text, /OKR/);

    const run = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers,
      body: { prompt: '把会议纪要整理', files: [] },
    });
    assert.equal(run.status, 200);

    const index = await jsonRequest(base, '/api/runs/index', { headers });
    assert.equal(index.status, 200);
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].recipeId, 'meeting-actions');

    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const schedule = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers,
      body: { name: 'once', fireAt, payload: { recipeId: 'meeting-actions' } },
    });
    assert.equal(schedule.status, 200);
    assert.match(schedule.body.schedule.id, /^sched_/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
