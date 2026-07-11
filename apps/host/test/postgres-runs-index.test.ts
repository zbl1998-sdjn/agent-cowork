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
        if (!rec) return { rows: [] };
        if (t.includes('tenant_id=') && rec.tenantId !== String(params[1])) return { rows: [] };
        if (t.includes('user_id=') && rec.userId !== String(params[2])) return { rows: [] };
        return { rows: [{ record_json: JSON.stringify(rec) }] };
      }
      if (t.startsWith('INSERT INTO runs_index')) {
        const rec = parseStoredRecord(params[18]);
        const existing = rows.get(rec.id);
        if (existing && (existing.tenantId !== rec.tenantId || existing.userId !== rec.userId)) {
          return { rowCount: 0, rows: [] };
        }
        const stored = existing ? { ...rec, version: existing.version + 1 } : rec;
        rows.set(stored.id, stored);
        return { rowCount: 1, rows: [{ record_json: JSON.stringify(stored) }] };
      }
      if (t.startsWith('DELETE FROM runs_index WHERE id=')) {
        const id = stringParam(params, 0);
        const rec = rows.get(id);
        const had = Boolean(rec && rec.tenantId === String(params[1]) && rec.userId === String(params[2]));
        if (had) rows.delete(id);
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
        const scoped = [...rows.values()].filter((r) =>
          (!t.includes('tenant_id=') || r.tenantId === String(params[0]))
          && (!t.includes('user_id=') || r.userId === String(params[1])));
        for (const r of scoped) m[r.status] = (m[r.status] || 0) + 1;
        return { rows: Object.entries(m).map(([status, count]) => ({ status, count })) };
      }
      if (t.includes('GROUP BY type')) {
        const m: Record<string, number> = Object.create(null);
        const scoped = [...rows.values()].filter((r) =>
          (!t.includes('tenant_id=') || r.tenantId === String(params[0]))
          && (!t.includes('user_id=') || r.userId === String(params[1])));
        for (const r of scoped) m[r.type] = (m[r.type] || 0) + 1;
        return { rows: Object.entries(m).map(([type, count]) => ({ type, count })) };
      }
      if (t.includes('COUNT(*)')) {
        const scoped = [...rows.values()].filter((r) =>
          (!t.includes('tenant_id=') || r.tenantId === String(params[0]))
          && (!t.includes('user_id=') || r.userId === String(params[1])));
        return { rows: [{ count: scoped.length }] };
      }
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
  pool.queries.length = 0;
  const b = await idx.upsert({ id: 'run_1', tenantId: 't1', userId: 'u1', type: 'agent-chat', status: 'failed' });
  assert.equal(b.version, 2, 'version bumped on existing id');
  assert.equal(pool.queries.length, 1, 'same-owner re-upsert must be a single atomic query');
});

test('PostgresRunsIndex upsert is one atomic owner-conditional query and rejects cross-owner overwrite', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'owned', tenantId: 'tenant-a', userId: 'user-a', type: 'agent-chat', status: 'running' });

  pool.queries.length = 0;
  await assert.rejects(
    () => idx.upsert({ id: 'owned', tenantId: 'tenant-b', userId: 'user-a', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );
  assert.equal(pool.queries.length, 1, 'upsert must not SELECT before the conditional write');
  assert.match(itemAt(pool.queries, 0, 'atomic upsert query').t, /^INSERT INTO runs_index/);
  assert.match(itemAt(pool.queries, 0, 'atomic upsert query').t, /WHERE .*tenant_id\s*=\s*EXCLUDED\.tenant_id.*user_id\s*=\s*EXCLUDED\.user_id/i);

  await assert.rejects(
    () => idx.upsert({ id: 'owned', tenantId: 'tenant-a', userId: 'user-b', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );
  const original = await idx.get('owned', { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(original?.status, 'running');
  assert.equal(original?.version, 1);
});

test('PostgresRunsIndex.get enforces exact tenant and user isolation in SQL', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'run_2', tenantId: 't1', userId: 'u1', type: 'x', status: 'done' });
  assert.ok(await idx.get('run_2', { tenantId: 't1', userId: 'u1' }));
  assert.equal(await idx.get('run_2', { tenantId: 't2', userId: 'u1' }), null, 'other tenant cannot read');
  assert.equal(await idx.get('run_2', { tenantId: 't1', userId: 'u2' }), null, 'sibling user cannot read');
  const scopedGet = [...pool.queries].reverse().find((query) => query.t.startsWith('SELECT record_json FROM runs_index WHERE id=') && query.params.length === 3);
  assert.ok(scopedGet, 'tenant+user get query should execute both owner predicates');
  assert.match(scopedGet.t, /tenant_id=\$2/);
  assert.match(scopedGet.t, /user_id=\$3/);
});

test('PostgresRunsIndex rejects non-canonical owners and provided-invalid filters', async () => {
  const idx = new PostgresRunsIndex({ pool: mockPool() });
  await assert.rejects(
    () => idx.upsert({ id: 'missing_user', tenantId: 'tenant-a', status: 'running' }),
    /canonical tenantId and userId/i,
  );
  await assert.rejects(
    () => idx.upsert({ id: 'trimmed', tenantId: ' tenant-a', userId: 'user-a', status: 'running' }),
    /canonical tenantId and userId/i,
  );
  await assert.rejects(
    () => idx.get('missing', { tenantId: undefined }),
    /identity filter/i,
  );
  await assert.rejects(
    () => idx.list({ userId: ' user-a' }),
    /identity filter/i,
  );
  await assert.rejects(
    () => idx.stats({ tenantId: ['tenant-a'] }),
    /identity filter/i,
  );
});

test('PostgresRunsIndex fails closed for stored records with invalid owners', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'valid', tenantId: 'tenant-a', userId: 'user-a', type: 'x', status: 'done' });
  pool._rows.set('corrupt', {
    ...pool._rows.get('valid'),
    id: 'corrupt',
    tenantId: ' tenant-a',
  } as RunRecord);

  assert.equal(await idx.get('corrupt'), null);
  assert.deepEqual((await idx.list()).map((record) => record.id), ['valid']);
});

test('PostgresRunsIndex list/size/stats/remove work through the adapter', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'r_a', tenantId: 't1', userId: 'user_local', type: 'agent-chat', status: 'succeeded', startedAt: '2026-05-23T01:00:00Z' });
  await idx.upsert({ id: 'r_b', tenantId: 't1', userId: 'user_local', type: 'recipe', status: 'failed', startedAt: '2026-05-23T02:00:00Z' });
  const list = await idx.list({ tenantId: 't1', limit: 10 });
  assert.equal(list.length, 2);
  assert.equal(itemAt(list, 0, 'newest run').id, 'r_b', 'newest first');
  assert.equal(await idx.size(), 2);
  const stats = await idx.stats({ tenantId: 't1' });
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.succeeded, 1);
  assert.equal(stats.byType.recipe, 1);
  await assert.rejects(() => idx.remove('r_a'), /owner context/);
  assert.equal(await idx.remove('r_a', { tenantId: 't1', userId: 'other' }), false);
  assert.equal(await idx.remove('r_a', { tenantId: 't1', userId: 'user_local' }), true);
  assert.equal(await idx.size(), 1);
});

test('PostgresRunsIndex.stats applies exact tenant and user scope', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  await idx.upsert({ id: 'alice', tenantId: 'shared', userId: 'alice', type: 'agent-chat', status: 'succeeded' });
  await idx.upsert({ id: 'bob', tenantId: 'shared', userId: 'bob', type: 'recipe', status: 'failed' });

  const stats = await idx.stats({ tenantId: 'shared', userId: 'alice' });
  assert.equal(stats.total, 1);
  assert.equal(stats.byStatus.succeeded, 1);
  assert.equal(stats.byStatus.failed, undefined);
  assert.equal(stats.byType['agent-chat'], 1);
  assert.equal(stats.byType.recipe, undefined);
  const statsQueries = pool.queries.filter((query) => query.t.includes('COUNT(*)'));
  assert.ok(statsQueries.some((query) => /tenant_id=\$1 AND user_id=\$2/.test(query.t)), 'stats SQL should execute tenant+user scope');
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
  await wrapped.upsert({ id: 'safe_1', tenantId: 't1', userId: 'user_local', type: 'agent-chat', status: 'succeeded' });
  assert.ok(await wrapped.get('safe_1'));
  assert.equal(await wrapped.remove('safe_1', { tenantId: 't1', userId: 'user_local' }), true);
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
