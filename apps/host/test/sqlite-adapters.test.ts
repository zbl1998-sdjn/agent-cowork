import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { SqliteMemoryStore, flushMemoryAuditEvents } from '../src/memory/memory-store.js';
import { resolveStoreBackendConfig } from '../src/runtime/store-backend-config.js';
import { SqliteRunsIndex, createUlid } from '../src/runtime/runs-index.js';
import { Scheduler, SqliteScheduleStore } from '../src/runtime/scheduler.js';
import { createServer } from '../src/server.js';
import { migrateSqliteDatabase, openSqliteDatabase } from '../src/storage/sqlite.js';
import { closeTestServer } from './helpers/close-server.js';
import { samePathReal } from './helpers/path-swap.js';
import type { HostServer } from '../src/server.js';

type JsonRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

type JsonResponse = {
  status: number;
  body: unknown;
  headers: Headers;
};

const require = createRequire(import.meta.url);

function hasNodeSqlite(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const sqliteAvailable = hasNodeSqlite();

function tempRoot(prefix = 'kcw-sqlite-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => recordValue(item, `${label}[${index}]`));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { address: host, port } = address as AddressInfo;
  return `http://${host}:${port}`;
}

async function jsonRequest(base: string, route: string, { method = 'GET', body, headers = {} }: JsonRequestOptions = {}): Promise<JsonResponse> {
  const init: RequestInit = {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  };
  if (body != null) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as unknown : null,
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

  const got = present(index.get(id, { tenantId: 'tenant_alice' }), 'sqlite run index record');
  assert.equal(got.status, 'succeeded');
  assert.equal(got.version, 2);
  assert.equal(index.get(id, { tenantId: 'tenant_bob' }), null);
  assert.deepEqual(index.list({ tenantId: 'tenant_alice' }).map((record) => record.id), [id]);
  assert.equal(index.stats({ tenantId: 'tenant_alice' }).total, 1);

  const reopened = new SqliteRunsIndex({ dbPath });
  assert.equal(present(reopened.get(id), 'reopened run index record').status, 'succeeded');
  assert.equal(reopened.remove(id, { tenantId: 'tenant_alice', userId: 'user_alice' }), true);
  assert.equal(reopened.size(), 0);
});

test('SqliteRunsIndex rejects cross-owner upserts and scopes get/stats by tenant and user', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const index = new SqliteRunsIndex({ dbPath: path.join(root, 'state.sqlite') });
  index.upsert({ id: 'owned', tenantId: 'shared', userId: 'alice', type: 'agent-chat', status: 'running' });
  index.upsert({ id: 'bob-run', tenantId: 'shared', userId: 'bob', type: 'agent-chat', status: 'failed' });

  assert.throws(
    () => index.upsert({ id: 'owned', tenantId: 'other', userId: 'alice', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );
  assert.throws(
    () => index.upsert({ id: 'owned', tenantId: 'shared', userId: 'bob', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );

  const original = present(index.get('owned', { tenantId: 'shared', userId: 'alice' }), 'sqlite original owner record');
  assert.equal(original.status, 'running');
  assert.equal(original.version, 1);
  assert.equal(index.get('owned', { tenantId: 'other', userId: 'alice' }), null);
  assert.equal(index.get('owned', { tenantId: 'shared', userId: 'bob' }), null);
  assert.throws(() => index.remove('owned'), /owner context/);
  assert.equal(index.remove('owned', { tenantId: 'shared', userId: 'bob' }), false);
  assert.ok(index.get('owned', { tenantId: 'shared', userId: 'alice' }));
  const aliceStats = index.stats({ tenantId: 'shared', userId: 'alice' });
  assert.equal(aliceStats.total, 1);
  assert.equal(aliceStats.byStatus.running, 1);
  assert.equal(aliceStats.byStatus.failed, undefined);
});

test('SqliteMemoryStore stores owner-scoped facts and notes', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'state.sqlite');
  const store = new SqliteMemoryStore({ dbPath });
  const alice = { tenantId: 'tenant_shared', userId: 'alice', traceId: 'trace_1' };
  const bob = { tenantId: 'tenant_shared', userId: 'bob' };

  const fact = store.appendMemoryFact(
    root,
    { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营', scope: 'project' },
    alice,
  );
  assert.equal(fact.fact.key, '客户简称');
  assert.match(fact.file, /^sqlite:\/\/memory_facts\//);

  store.appendMemoryFact(root, { key: '隔离', value: '不应泄漏' }, bob);
  const body = store.readMainMemory(root, alice);
  assert.match(body, /客户简称/);
  assert.equal(/不应泄漏/.test(body), false, 'owner-scoped memory should not leak to a sibling user');

  const notePath = store.writeMemoryNote(
    root,
    'projects.md',
    '# Projects\n- Alpha\n',
    alice,
  );
  assert.match(notePath, /^sqlite:\/\/memory_notes\//);
  assert.match(present(store.readMemoryNote(root, 'projects.md', alice), 'sqlite memory note'), /Alpha/);
  assert.equal(store.listMemoryNotes(root, alice).length, 1);
  assert.equal(store.loadMemoryContext(root, { context: alice }).enabled, true);
});

test('SqliteScheduleStore persists schedules across Scheduler instances', { skip: !sqliteAvailable }, async () => {
  const root = tempRoot();
  const dbPath = path.join(root, 'state.sqlite');
  let nowMs = new Date('2026-05-18T08:59:00').getTime();
  const fired: string[] = [];
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

  nowMs = Date.parse(present(record.nextFireAt, 'sqlite schedule nextFireAt')) + 1000;
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(fired.length, 1);

  const reopened = new Scheduler({
    store: new SqliteScheduleStore({ dbPath }),
    executor: async () => ({ runId: 'unused' }),
    now: () => new Date(nowMs),
  });
  const after = present(reopened.get(record.id), 'reopened sqlite schedule');
  assert.equal(after.runs, 1);
  assert.equal(after.lastRunId, `run_${record.id}`);
});

test('server storeBackend=sqlite wires memory, runs index, and schedules', { skip: !sqliteAvailable }, async () => {
  const trustedRoot = tempRoot();
  const dbPath = path.join(trustedRoot, '.AgentCowork', 'state.sqlite');
  const server = createServer({
    trustedRoot,
    storeBackend: 'sqlite',
    sqliteDbPath: dbPath,
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'x-trace-id': 'trace_sqlite' };
    const fact = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      headers,
      body: { key: '术语', value: 'OKR = Objectives and Key Results' },
    });
    assert.equal(fact.status, 200);
    await flushMemoryAuditEvents(trustedRoot);
    const auditPath = path.join(trustedRoot, '.AgentCowork', 'audit', 'memory.jsonl');
    assert.ok(fs.existsSync(auditPath), 'sqlite memory writes must emit audit JSONL');
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => recordValue(JSON.parse(line) as unknown, 'memory audit line'));
    assert.ok(auditLines.some((line) => line.trace_id === 'trace_sqlite' && line.action === 'memory_fact_append'));

    const memory = await jsonRequest(base, '/api/memory', { headers });
    assert.equal(memory.status, 200);
    const memoryBody = recordValue(memory.body, 'memory response body');
    assert.match(String(recordValue(memoryBody.memory, 'memory payload').text), /OKR/);

    const run = await jsonRequest(base, '/api/recipes/email-draft/run', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'sqlite-run' },
      body: { prompt: '把会议纪要整理', files: [] },
    });
    assert.equal(run.status, 200);

    const index = await jsonRequest(base, '/api/runs/index', { headers });
    assert.equal(index.status, 200);
    const indexedRuns = recordArray(recordValue(index.body, 'runs index response body').runs, 'runs index records');
    assert.equal(indexedRuns.length, 1);
    assert.equal(present(indexedRuns[0], 'first sqlite indexed run').recipeId, 'email-draft');

    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const schedule = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'sqlite-schedule' },
      body: { name: 'once', fireAt, payload: { recipeId: 'meeting-actions' } },
    });
    assert.equal(schedule.status, 200);
    assert.match(String(recordValue(recordValue(schedule.body, 'schedule response body').schedule, 'schedule payload').id), /^sched_/);
  } finally {
    await closeTestServer(server);
  }
});

test('SQLite migrations can use embedded SQL when migration files are not present', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const db = openSqliteDatabase(path.join(root, 'state.sqlite'));
  migrateSqliteDatabase(db, {
    migrationsPath: path.join(root, 'missing-migrations'),
    useEmbeddedMigrations: true,
  });

  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('runs_index', 'memory_facts', 'memory_notes', 'schedules')
    ORDER BY name
  `).all().map((row) => String(recordValue(row, 'sqlite table row').name));
  assert.deepEqual(tables, ['memory_facts', 'memory_notes', 'runs_index', 'schedules']);
  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(recordValue(row, 'schema migration row').id));
  assert.deepEqual(applied, ['0001_init.sql']);
});

test('SQLite migrations roll back failed migration files atomically', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const migrationsPath = path.join(root, 'migrations');
  fs.mkdirSync(migrationsPath, { recursive: true });
  fs.writeFileSync(
    path.join(migrationsPath, '0001_ok.sql'),
    'CREATE TABLE ok_table (id TEXT PRIMARY KEY);\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(migrationsPath, '0002_bad.sql'),
    'CREATE TABLE rollback_probe (id TEXT PRIMARY KEY);\nSELECT * FROM table_that_does_not_exist;\n',
    'utf8',
  );

  const db = openSqliteDatabase(path.join(root, 'state.sqlite'));
  assert.throws(() => migrateSqliteDatabase(db, { migrationsPath }), /table_that_does_not_exist|no such table/i);

  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((row) => String(recordValue(row, 'schema migration row').id));
  assert.deepEqual(applied, ['0001_ok.sql']);
  const leakedTable = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'rollback_probe'
  `).get();
  assert.equal(leakedTable, undefined);
});

test('resolveStoreBackendConfig prefers explicit config and falls back to environment safely', () => {
  const root = tempRoot('kcw-store-backend-');
  const original = {
    KCW_STORE: process.env.KCW_STORE,
    DATABASE_URL: process.env.DATABASE_URL,
    KCW_SQLITE_PATH: process.env.KCW_SQLITE_PATH,
  };
  try {
    delete process.env.KCW_STORE;
    delete process.env.DATABASE_URL;
    delete process.env.KCW_SQLITE_PATH;

    const defaults = resolveStoreBackendConfig({}, root);
    assert.equal(defaults.storeBackend, 'sqlite');
    assert.equal(defaults.databaseUrl, null);
    assert.equal(defaults.usePostgresState, false);
    assert.ok(samePathReal(defaults.sqliteDbPath, path.resolve(root, '.AgentCowork', 'state.sqlite')));

    process.env.KCW_STORE = 'postgres';
    assert.throws(
      () => resolveStoreBackendConfig({}, root),
      /KCW_STORE=postgres requires DATABASE_URL/,
    );
    delete process.env.KCW_STORE;

    process.env.DATABASE_URL = 'postgres://example.invalid/agent_cowork_test';
    const urlOnly = resolveStoreBackendConfig({}, root);
    assert.equal(urlOnly.storeBackend, 'sqlite');
    assert.equal(urlOnly.usePostgresState, false);

    process.env.KCW_STORE = 'postgres';
    process.env.KCW_SQLITE_PATH = path.join(root, 'env-state.sqlite');
    const fromEnv = resolveStoreBackendConfig({}, root);
    assert.equal(fromEnv.storeBackend, 'postgres');
    assert.equal(fromEnv.databaseUrl, 'postgres://example.invalid/agent_cowork_test');
    assert.equal(fromEnv.usePostgresState, true);
    assert.ok(samePathReal(fromEnv.sqliteDbPath, path.resolve(root, 'env-state.sqlite')));

    const explicit = resolveStoreBackendConfig({
      storeBackend: 'sqlite',
      databaseUrl: null,
      sqliteDbPath: path.join(root, 'explicit-state.sqlite'),
    }, root);
    assert.equal(explicit.storeBackend, 'sqlite');
    assert.equal(explicit.databaseUrl, 'postgres://example.invalid/agent_cowork_test');
    assert.equal(explicit.usePostgresState, false);
    assert.ok(samePathReal(explicit.sqliteDbPath, path.resolve(root, 'explicit-state.sqlite')));

    const explicitFile = resolveStoreBackendConfig({ storeBackend: 'file' }, root);
    assert.equal(explicitFile.storeBackend, 'file');
    assert.equal(explicitFile.usePostgresState, false);

    const unknown = resolveStoreBackendConfig({ storeBackend: 'memory' }, root);
    assert.equal(unknown.storeBackend, 'file');
  } finally {
    if (original.KCW_STORE === undefined) {
      delete process.env.KCW_STORE;
    } else {
      process.env.KCW_STORE = original.KCW_STORE;
    }
    if (original.DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original.DATABASE_URL;
    }
    if (original.KCW_SQLITE_PATH === undefined) {
      delete process.env.KCW_SQLITE_PATH;
    } else {
      process.env.KCW_SQLITE_PATH = original.KCW_SQLITE_PATH;
    }
  }
});
