import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresRunsIndex } from '../src/storage/postgres-runs-index.js';

// In-memory mock of a pg Pool: interprets the adapter's SQL by keyword so we can
// verify param mapping + record round-trip without a live Postgres.
function mockPool() {
  const rows = new Map();
  const queries = [];
  return {
    queries,
    _rows: rows,
    async query(text, params = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      queries.push({ t, params });
      if (t.startsWith('SELECT record_json FROM runs_index WHERE id=')) {
        const rec = rows.get(params[0]);
        return { rows: rec ? [{ record_json: JSON.stringify(rec) }] : [] };
      }
      if (t.startsWith('INSERT INTO runs_index')) {
        const rec = JSON.parse(params[18]);
        rows.set(rec.id, rec);
        return { rowCount: 1 };
      }
      if (t.startsWith('DELETE FROM runs_index WHERE id=')) {
        const had = rows.has(params[0]);
        rows.delete(params[0]);
        return { rowCount: had ? 1 : 0 };
      }
      if (t.includes('FROM runs_index') && t.includes('ORDER BY')) {
        const list = [...rows.values()].sort((a, b) => String(b.startedAt || b.updatedAt).localeCompare(String(a.startedAt || a.updatedAt)));
        const cap = params[params.length - 1];
        return { rows: list.slice(0, cap).map((r) => ({ record_json: JSON.stringify(r) })) };
      }
      if (t.includes('GROUP BY status')) {
        const m = {}; for (const r of rows.values()) m[r.status] = (m[r.status] || 0) + 1;
        return { rows: Object.entries(m).map(([status, count]) => ({ status, count })) };
      }
      if (t.includes('GROUP BY type')) {
        const m = {}; for (const r of rows.values()) m[r.type] = (m[r.type] || 0) + 1;
        return { rows: Object.entries(m).map(([type, count]) => ({ type, count })) };
      }
      if (t.includes('COUNT(*)')) return { rows: [{ count: rows.size }] };
      return { rows: [] };
    },
  };
}

test('PostgresRunsIndex.upsert inserts with ON CONFLICT and bumps version on re-upsert', async () => {
  const pool = mockPool();
  const idx = new PostgresRunsIndex({ pool });
  const a = await idx.upsert({ id: 'run_1', tenantId: 't1', userId: 'u1', type: 'agent-chat', status: 'succeeded', startedAt: '2026-05-23T00:00:00Z' });
  assert.equal(a.version, 1);
  const insert = pool.queries.find((q) => q.t.startsWith('INSERT INTO runs_index'));
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
  assert.equal(list[0].id, 'r_b', 'newest first');
  assert.equal(await idx.size(), 2);
  const stats = await idx.stats({ tenantId: 't1' });
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.succeeded, 1);
  assert.equal(stats.byType.recipe, 1);
  assert.equal(await idx.remove('r_a'), true);
  assert.equal(await idx.size(), 1);
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
