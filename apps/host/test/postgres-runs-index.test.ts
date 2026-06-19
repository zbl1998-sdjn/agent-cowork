import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { PostgresRunsIndex } from '../src/storage/postgres-runs-index.js';
import type { PgPool, PgResult, RunRecord } from '../src/storage/postgres-runs-index.js';

type QueryLog = { t: string; params: unknown[] };
type MockPool = PgPool & {
  queries: QueryLog[];
  _rows: Map<string, RunRecord>;
  closeCount: number;
};

const storedRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  userId: z.string(),
  type: z.string(),
  status: z.string(),
  startedAt: z.unknown().optional(),
  updatedAt: z.string(),
  version: z.number(),
}).loose();

function stringParam(params: readonly unknown[], index: number): string {
  return z.string().parse(params[index]);
}

function intParam(params: readonly unknown[], index: number): number {
  return z.number().int().parse(params[index]);
}

function parseStoredRecord(value: unknown): RunRecord {
  return storedRecordSchema.parse(JSON.parse(z.string().parse(value))) as RunRecord;
}

function findQuery(pool: MockPool, startsWith: string): QueryLog {
  const query = pool.queries.find((candidate) => candidate.t.startsWith(startsWith));
  assert.ok(query, `query starting with ${startsWith} should be recorded`);
  return query;
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  assert.ok(item, `${label} should exist`);
  return item;
}

// In-memory mock of a pg Pool: interprets the adapter's SQL by keyword so we can
// verify param mapping + record round-trip without a live Postgres.
function mockPool(): MockPool {
  const rows = new Map<string, RunRecord>();
  const queries: QueryLog[] = [];
  const pool = {
    queries,
    _rows: rows,
    closeCount: 0,
    async query(text: string, params: unknown[] = []): Promise<PgResult> {
      const t = text.replace(/\s+/g, ' ').trim();
      queries.push({ t, params });
      if (t.startsWith('SELECT record_json FROM runs_index WHERE id=')) {
        const rec = rows.get(stringParam(params, 0));
        return { rows: rec ? [{ record_json: JSON.stringify(rec) }] : [] };
      }
      if (t.startsWith('INSERT INTO runs_index')) {
        const rec = parseStoredRecord(params[18]);
        rows.set(rec.id, rec);
        return { rowCount: 1 };
      }
      if (t.startsWith('DELETE FROM runs_index WHERE id=')) {
        const id = stringParam(params, 0);
        const had = rows.has(id);
        rows.delete(id);
        return { rowCount: had ? 1 : 0 };
      }
      if (t.includes('FROM runs_index') && t.includes('ORDER BY')) {
        let list = [...rows.values()].sort((a, b) => String(b.startedAt || b.updatedAt).localeCompare(String(a.startedAt || a.updatedAt)));
        for (const filter of params.slice(0, -1)) {
          const value = String(filter);
          list = list.filter((r) => [r.tenantId, r.userId, r.status, r.type, r.recipeId].includes(value));
        }
        const cap = intParam(params, params.length - 1);
        return { rows: list.slice(0, cap).map((r) => ({ record_json: JSON.stringify(r) })) };
      }
      if (t.includes('GROUP BY status')) {
        const m: Record<string, number> = Object.create(null);
        for (const r of rows.values()) m[r.status] = (m[r.status] || 0) + 1;
        return { rows: Object.entries(m).map(([status, count]) => ({ status, count })) };
      }
      if (t.includes('GROUP BY type')) {
        const m: Record<string, number> = Object.create(null);
        for (const r of rows.values()) m[r.type] = (m[r.type] || 0) + 1;
        return { rows: Object.entries(m).map(([type, count]) => ({ type, count })) };
      }
      if (t.includes('COUNT(*)')) return { rows: [{ count: rows.size }] };
      return { rows: [] };
    },
    async end(): Promise<void> {
      pool.closeCount += 1;
    },
  };
  return pool;
}

test('PostgresRunsIndex.upsert inserts with ON CONFLICT and bumps version on re-upsert', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  const a = await idx.upsert({ id: 'run_1', tenantId: 't1', userId: 'u1', type: 'agent-chat', status: 'succeeded', startedAt: '2026-05-23T00:00:00Z' });
  assert.equal(a.version, 1);
  const insert = findQuery(pool, 'INSERT INTO runs_index');
  assert.match(insert.t, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(insert.t, /\$19/);
  assert.equal(insert.params.length, 19);
  const b = await idx.upsert({ id: 'run_1', tenantId: 't1', userId: 'u1', type: 'agent-chat', status: 'failed' });
  assert.equal(b.version, 2, 'version bumped on existing id');
});

test('PostgresRunsIndex.get enforces tenant isolation', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'run_2', tenantId: 't1', type: 'x', status: 'done' });
  assert.ok(await idx.get('run_2', { tenantId: 't1' }));
  assert.equal(await idx.get('run_2', { tenantId: 't2' }), null, 'other tenant cannot read');
});

test('PostgresRunsIndex list/size/stats/remove work through the adapter', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'r_a', tenantId: 't1', type: 'agent-chat', status: 'succeeded', startedAt: '2026-05-23T01:00:00Z' });
  await idx.upsert({ id: 'r_b', tenantId: 't1', type: 'recipe', status: 'failed', startedAt: '2026-05-23T02:00:00Z' });
  const list = await idx.list({ tenantId: 't1', limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(itemAt(list, 0, 'newest run').id, 'r_b', 'newest first');
  assert.equal(await idx.size(), 2);
  const stats = await idx.stats({ tenantId: 't1' });
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.succeeded, 1);
  assert.equal(stats.byType.recipe, 1);
  assert.equal(await idx.remove('r_a'), true);
  assert.equal(await idx.size(), 1);
});

test('PostgresRunsIndex.list applies every public filter and clamps limit', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'filter_a', tenantId: 'tenant-a', userId: 'user-a', type: 'agent-chat', status: 'succeeded', recipeId: 'summary-report', startedAt: '2026-05-23T01:00:00Z' });
  await idx.upsert({ id: 'filter_b', tenantId: 'tenant-a', userId: 'user-b', type: 'recipe', status: 'failed', recipeId: 'meeting-actions', startedAt: '2026-05-23T02:00:00Z' });
  await idx.upsert({ id: 'filter_c', tenantId: 'tenant-b', userId: 'user-a', type: 'agent-chat', status: 'queued', recipeId: 'summary-report', startedAt: '2026-05-23T03:00:00Z' });

  const list = await idx.list({
    tenantId: 'tenant-a',
    userId: 'user-a',
    status: 'succeeded',
    type: 'agent-chat',
    recipeId: 'summary-report',
    limit: 9999,
  });

  assert.deepEqual(list.map((record) => record.id), ['filter_a']);
  const query = pool.queries.find((candidate) => candidate.t.startsWith('SELECT record_json FROM runs_index') && candidate.t.includes('ORDER BY'));
  assert.ok(query, 'filtered list query should be recorded');
  assert.match(query.t, /tenant_id=\$1/);
  assert.match(query.t, /user_id=\$2/);
  assert.match(query.t, /status=\$3/);
  assert.match(query.t, /type=\$4/);
  assert.match(query.t, /recipe_id=\$5/);
  assert.equal(query.params.at(-1), 500, 'limit is capped at 500 before reaching SQL');
});

test('PostgresRunsIndex.close delegates to the pool and factory/safe writer preserve the public contract', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  const wrapped = (await import('../src/storage/postgres-runs-index.js')).withSafeWrites(idx);
  await wrapped.upsert({ id: 'safe_1', tenantId: 't1', type: 'agent-chat', status: 'succeeded' });
  assert.ok(await wrapped.get('safe_1'));
  assert.equal(await wrapped.remove('safe_1'), true);
  assert.equal(await wrapped.size(), 0);
  const stats = await wrapped.stats();
  assert.equal(stats.total, 0);
  assert.deepEqual(Object.keys(stats.byStatus), []);
  assert.deepEqual(Object.keys(stats.byType), []);
  await wrapped.close?.();
  assert.equal(pool.closeCount, 1);
});

test('PostgresRunsIndex.withSafeWrites still returns rejecting promises while swallowing background rejection handlers', async () => {
  const failing = {
    upsert: async () => { throw new Error('write failed'); },
    remove: async () => { throw new Error('remove failed'); },
    get: async () => null,
    list: async () => [],
    size: async () => 0,
    stats: async () => ({ total: 0, byStatus: {}, byType: {} }),
  };
  const wrapped = (await import('../src/storage/postgres-runs-index.js')).withSafeWrites(failing);
  await assert.rejects(() => wrapped.upsert({ id: 'bad', type: 'agent-chat', status: 'failed' }), /write failed/);
  await assert.rejects(() => wrapped.remove('bad'), /remove failed/);
});

test('PostgresRunsIndex without pool or connectionString throws on first query', async () => {
  const idx = new PostgresRunsIndex({});
  await assert.rejects(() => idx.size(), /pool or connectionString/);
});

test('PostgresRunsIndex rejects unsafe table names', () => {
  assert.throws(
    () => new PostgresRunsIndex({ pool: mockPool(), table: 'runs_index;bad' }),
    /invalid table name/,
  );
});
