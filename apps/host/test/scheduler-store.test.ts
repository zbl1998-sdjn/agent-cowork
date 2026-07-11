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

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
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
          const existing = rows.get(saved.id);
          if (
            existing
            && (existing.tenantId !== saved.tenantId || existing.userId !== saved.userId)
          ) {
            return { changes: 0 };
          }
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

test('schedule stores reject invalid writes and skip records with unassignable owners', () => {
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  const partial = record({ id: 'sched_partial' });
  delete partial.userId;
  assert.throws(
    () => store.save(partial),
    /canonical tenantId and userId/i,
  );
  assert.throws(
    () => store.save(record({ id: 'sched_trimmed', tenantId: ' tenant_a' })),
    /canonical tenantId and userId/i,
  );
  const corrupt = record({ id: 'sched_corrupt_owner' });
  delete corrupt.userId;
  fs.writeFileSync(
    path.join(root, 'sched_corrupt_owner.json'),
    JSON.stringify(corrupt),
    'utf8',
  );
  assert.equal(store.get('sched_corrupt_owner'), null);
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.list({ tenantId: undefined }), /identity filter/i);
});

test('file and SQLite schedule stores reject cross-owner overwrite', () => {
  const fileStore = new FileScheduleStore({ storeDir: tempRoot() });
  fileStore.save(record({ id: 'sched_owned' }));
  assert.throws(
    () => fileStore.save(record({ id: 'sched_owned', userId: 'user_b' })),
    /owner/i,
  );
  assert.equal(fileStore.get('sched_owned')?.userId, 'user_a');

  const { db } = createFakeScheduleDb();
  const sqliteStore = new SqliteScheduleStore({ db });
  sqliteStore.save(record({ id: 'sched_owned' }));
  assert.throws(
    () => sqliteStore.save(record({ id: 'sched_owned', tenantId: 'tenant_b' })),
    /owner/i,
  );
  assert.equal(sqliteStore.get('sched_owned')?.tenantId, 'tenant_a');
});

test('FileScheduleStore preserves the existing record and removes its temp after a write failure', () => {
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  const file = path.join(root, 'sched_atomic.json');
  store.save(record({ id: 'sched_atomic', name: 'before' }));
  const before = fs.readFileSync(file);
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = ((...args: unknown[]) => {
    const [destination] = args;
    if (typeof destination === 'number') {
      const writeDescriptor = originalWriteFileSync as unknown as (
        descriptor: number,
        data: string,
        encoding: string,
      ) => void;
      writeDescriptor(destination, 'partial', 'utf8');
      throw new Error('injected schedule write failure');
    }
    return Reflect.apply(originalWriteFileSync, fs, args);
  }) as typeof fs.writeFileSync;

  try {
    assert.throws(
      () => store.save(record({ id: 'sched_atomic', name: 'after' })),
      /injected schedule write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
});

test('FileScheduleStore refuses to replace a parseable record missing required fields', () => {
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  const file = path.join(root, 'sched_incomplete.json');
  const before = JSON.stringify({
    id: 'sched_incomplete',
    tenantId: 'tenant_a',
    userId: 'user_a',
  });
  fs.writeFileSync(file, before, 'utf8');

  assert.throws(
    () => store.save(record({ id: 'sched_incomplete', name: 'replacement' })),
    /could not be verified/i,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('FileScheduleStore refuses to replace a record whose id disagrees with its file name', () => {
  const root = tempRoot();
  const store = new FileScheduleStore({ storeDir: root });
  const file = path.join(root, 'sched_target.json');
  const before = JSON.stringify(record({ id: 'sched_other' }));
  fs.writeFileSync(file, before, 'utf8');

  assert.throws(
    () => store.save(record({ id: 'sched_target', name: 'replacement' })),
    /could not be verified/i,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
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

test('FileScheduleStore rejects a store directory junction at construction', () => {
  const container = tempRoot();
  const outside = tempRoot();
  const storeDir = path.join(container, 'schedules');
  linkDirectory(outside, storeDir);

  assert.throws(
    () => new FileScheduleStore({ storeDir }),
    /symbolic link|junction|reparse/i,
  );
});

test('FileScheduleStore rejects every operation after its managed directory is swapped', () => {
  const container = tempRoot();
  const outside = tempRoot();
  const storeDir = path.join(container, 'schedules');
  const displaced = path.join(container, 'schedules-original');
  const store = new FileScheduleStore({ storeDir });
  store.save(record({ id: 'sched_before_swap' }));
  fs.renameSync(storeDir, displaced);
  linkDirectory(outside, storeDir);

  for (const operation of [
    () => store.list(),
    () => store.get('sched_before_swap'),
    () => store.save(record({ id: 'sched_after_swap' })),
    () => store.remove('sched_before_swap'),
  ]) {
    assert.throws(operation, /changed|symbolic link|junction|reparse|managed directory/i);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('FileScheduleStore revalidates after mkdir before publishing owner or schedule files', (t) => {
  const container = tempRoot();
  const outside = tempRoot();
  const storeDir = path.join(container, 'schedules');
  const displaced = path.join(container, 'schedules-original');
  const store = new FileScheduleStore({ storeDir });
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && path.resolve(String(args[0])).startsWith(path.resolve(storeDir))) {
      fs.renameSync(storeDir, displaced);
      try {
        linkDirectory(outside, storeDir);
      } catch (error) {
        fs.renameSync(displaced, storeDir);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    assert.throws(
      () => store.save(record({ id: 'sched_swap_during_save' })),
      /changed|symbolic link|junction|reparse|managed directory/i,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true, 'test must exercise the post-mkdir directory swap');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('FileScheduleStore never follows a schedule-file symlink', (t) => {
  const storeDir = tempRoot();
  const outside = tempRoot();
  const outsideFile = path.join(outside, 'outside.json');
  fs.writeFileSync(outsideFile, JSON.stringify(record({ id: 'sched_linked' })), 'utf8');
  try {
    symlinkSync(outsideFile, path.join(storeDir, 'sched_linked.json'), 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }
  const store = new FileScheduleStore({ storeDir });
  assert.throws(() => store.get('sched_linked'), /symbolic link|reparse/i);
});

test('normaliseTenantId and normaliseUserId accept only canonical scope values', () => {
  assert.equal(normaliseTenantId('tenant_a'), 'tenant_a');
  assert.equal(normaliseUserId('user_a'), 'user_a');
  for (const value of ['  ', null, 'x'.repeat(140), '用户']) {
    assert.throws(() => normaliseTenantId(value), /canonical identity part/i);
    assert.throws(() => normaliseUserId(value), /canonical identity part/i);
  }
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
  assert.throws(
    () => store.list({ tenantId: ' tenant_a ', userId: ' user_a ' }),
    /identity filter/i,
  );
  assert.deepEqual(store.list({ tenantId: 'tenant_a', userId: 'user_a' }).map((item) => item.id), ['sched_sql']);
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
