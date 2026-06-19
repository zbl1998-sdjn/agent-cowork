import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FileScheduleStore,
  SqliteScheduleStore,
  createScheduleStore,
  type ScheduleRecord,
} from '../src/runtime/scheduler.js';
import {
  normaliseTenantId,
  normaliseUserId,
} from '../src/runtime/scheduler-store.js';
import type { SqliteDatabase, SqliteStatement } from '../src/storage/sqlite.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-scheduler-store-'));
}

function record(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'sched_1',
    tenantId: 'tenant_a',
    userId: 'user_a',
    traceId: null,
    name: 'daily',
    kind: 'cron',
    status: 'pending',
    cron: '0 9 * * *',
    fireAt: null,
    nextFireAt: '2026-01-01T09:00:00.000Z',
    lastFiredAt: null,
    lastRunId: null,
    lastError: null,
    payload: { recipeId: 'summary-report' },
    version: 1,
    runs: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createFakeScheduleDb() {
  const rows = new Map<string, ScheduleRecord>();
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: SqliteDatabase = {
    exec: () => undefined,
    prepare(sql): SqliteStatement {
      return {
        all(...params) {
          calls.push({ sql, params });
          const [tenantId, userId] = params;
          return [...rows.values()]
            .filter((item) => !tenantId || item.tenantId === tenantId)
            .filter((item) => !userId || item.userId === userId)
            .sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')))
            .map((item) => ({ schedule_json: JSON.stringify(item) }));
        },
        get(id) {
          calls.push({ sql, params: [id] });
          const item = rows.get(String(id));
          return item ? { schedule_json: JSON.stringify(item) } : null;
        },
        run(...params) {
          calls.push({ sql, params });
          if (/DELETE FROM schedules/.test(sql)) {
            const existed = rows.delete(String(params[0]));
            return { changes: existed ? 1 : 0 };
          }
          const saved = JSON.parse(String(params[16])) as ScheduleRecord;
          rows.set(saved.id, saved);
          return { changes: 1 };
        },
      };
    },
  };
  return { db, calls, rows };
}

test('FileScheduleStore filters tenant/user records while ignoring corrupt schedule files', () => {
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  store.save(record({ id: 'sched_late', nextFireAt: '2026-01-02T09:00:00.000Z' }));
  store.save(record({ id: 'sched_early', nextFireAt: '2026-01-01T08:00:00.000Z' }));
  store.save(record({ id: 'sched_other_tenant', tenantId: 'tenant_b', userId: 'user_b' }));
  fs.writeFileSync(path.join(root, 'bad.json'), '{bad json', 'utf8');
  fs.writeFileSync(path.join(root, 'note.txt'), 'ignored', 'utf8');

  assert.deepEqual(store.list({ tenantId: 'tenant_a', userId: 'user_a' }).map((item) => item.id), ['sched_early', 'sched_late']);
  assert.equal(store.get('bad'), null);
  assert.equal(store.get('missing'), null);
});

test('FileScheduleStore validates ids and handles missing store directories and deletes', () => {
  assert.throws(() => new FileScheduleStore(), /storeDir required/);
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  const saved = store.save(record({ id: 'sched_delete_me' }));
  assert.equal(store.get(saved.id)?.id, saved.id);
  assert.equal(store.remove('sched_delete_me'), true);
  assert.equal(store.remove('sched_delete_me'), false);
  assert.throws(() => store.get('../escape'), /invalid schedule id/);

  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(store.list(), []);
});

test('normaliseTenantId and normaliseUserId clamp blank and oversized scope values', () => {
  assert.equal(normaliseTenantId('  '), 'tenant_local');
  assert.equal(normaliseUserId(null), 'user_local');
  assert.equal(normaliseTenantId('x'.repeat(140)).length, 96);
  assert.equal(normaliseUserId('u'.repeat(140)).length, 96);
});

test('SqliteScheduleStore saves, reads, lists, and removes schedules through the adapter contract', () => {
  assert.throws(() => new SqliteScheduleStore(), /dbPath is required/);
  const { db, calls } = createFakeScheduleDb();
  const store = new SqliteScheduleStore({ db });

  const sqliteRecord = record({ id: 'sched_sql' });
  delete sqliteRecord.version;
  delete sqliteRecord.runs;
  const saved = store.save(sqliteRecord);
  assert.equal(saved.id, 'sched_sql');
  const saveCall = calls.find((call) => /INSERT INTO schedules/.test(call.sql));
  assert.ok(saveCall, 'save should issue an upsert statement');
  assert.equal(saveCall.params[12], 1);
  assert.equal(saveCall.params[13], 0);

  assert.equal(store.get('sched_sql')?.id, 'sched_sql');
  store.save(record({ id: 'sched_other', tenantId: 'tenant_b', userId: 'user_b', nextFireAt: '2026-01-01T07:00:00.000Z' }));
  assert.deepEqual(store.list({ tenantId: ' tenant_a ', userId: ' user_a ' }).map((item) => item.id), ['sched_sql']);
  assert.equal(store.remove('sched_sql'), true);
  assert.equal(store.remove('sched_sql'), false);
});

test('createScheduleStore chooses file or sqlite backends without constructing sqlite when db is injected', () => {
  const fileStore = createScheduleStore({ backend: 'file', storeDir: tempRoot() });
  assert.ok(fileStore instanceof FileScheduleStore);

  const { db } = createFakeScheduleDb();
  const sqliteStore = createScheduleStore({ backend: 'sqlite', db });
  assert.ok(sqliteStore instanceof SqliteScheduleStore);
});
