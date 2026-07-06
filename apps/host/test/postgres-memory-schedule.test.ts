import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresScheduleStore } from '../src/storage/postgres-schedule-store.js';
import { PostgresMemoryStore } from '../src/storage/postgres-memory-store.js';
import type { PgPool as MemoryPgPool } from '../src/storage/postgres-memory-store.js';
import type { PgPool as SchedulePgPool, ScheduleRecord } from '../src/storage/postgres-schedule-store.js';

type ScheduleRow = { tenant_id: unknown; user_id: unknown; schedule_json: string };
type MemoryFactRow = { id: unknown; tenant_id: unknown; created_at: unknown; fact_json: string };
type MemoryNoteRow = {
  id: unknown;
  tenant_id: unknown;
  name: string;
  body: string;
  size: number;
  created_at: unknown;
  updated_at: unknown;
};

type ScheduleMockPool = SchedulePgPool & { closeCount: number };
type MemoryMockPool = MemoryPgPool & { closeCount: number };

function schedPool(): ScheduleMockPool {
  const rows = new Map<string, ScheduleRow>();
  const pool = {
    closeCount: 0,
    async query(text: string, params: unknown[] = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO schedules')) {
        const rec = JSON.parse(String(params[16] ?? '{}')) as ScheduleRecord;
        rows.set(rec.id, { tenant_id: params[1], user_id: params[2], schedule_json: String(params[16] ?? '') });
        return { rowCount: 1 };
      }
      if (t.startsWith('SELECT schedule_json FROM schedules WHERE id=')) {
        const r = rows.get(String(params[0] ?? ''));
        return { rows: r ? [{ schedule_json: r.schedule_json }] : [] };
      }
      if (t.startsWith('SELECT schedule_json FROM schedules')) {
        let list = [...rows.values()];
        if (t.includes('tenant_id=$1')) list = list.filter((r) => r.tenant_id === params[0]);
        if (t.includes('user_id=$2')) list = list.filter((r) => r.user_id === params[1]);
        return { rows: list.map((r) => ({ schedule_json: r.schedule_json })) };
      }
      if (t.startsWith('DELETE FROM schedules WHERE id=')) {
        const id = String(params[0] ?? '');
        const had = rows.has(id); rows.delete(id); return { rowCount: had ? 1 : 0 };
      }
      return { rows: [] };
    },
    async end(): Promise<void> {
      pool.closeCount += 1;
    },
  };
  return pool;
}

function memPool(): MemoryMockPool {
  const facts: MemoryFactRow[] = [];
  const notes = new Map<string, MemoryNoteRow>();
  const pool = {
    closeCount: 0,
    async query(text: string, params: unknown[] = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO memory_facts')) {
        facts.push({ id: params[0], tenant_id: params[1], created_at: params[7], fact_json: String(params[9] ?? '') });
        return { rowCount: 1 };
      }
      if (t.startsWith('SELECT fact_json FROM memory_facts WHERE tenant_id=')) {
        const list = facts.filter((f) => f.tenant_id === params[0]).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
        return { rows: list.map((f) => ({ fact_json: f.fact_json })) };
      }
      if (t.startsWith('SELECT id, created_at FROM memory_notes WHERE tenant_id=')) { const n = notes.get(`${params[0]}|${params[1]}`); return { rows: n ? [{ id: n.id, created_at: n.created_at }] : [] }; }
      if (t.startsWith('INSERT INTO memory_notes')) {
        notes.set(`${params[1]}|${params[4]}`, {
          id: params[0],
          tenant_id: params[1],
          name: String(params[4] ?? ''),
          body: String(params[5] ?? ''),
          size: Number(params[6] ?? 0),
          created_at: params[7],
          updated_at: params[8],
        });
        return { rowCount: 1 };
      }
      if (t.startsWith('SELECT body FROM memory_notes WHERE tenant_id=')) { const n = notes.get(`${params[0]}|${params[1]}`); return { rows: n ? [{ body: n.body }] : [] }; }
      if (t.startsWith('SELECT id, name, size, created_at, updated_at FROM memory_notes WHERE tenant_id=')) {
        const list = [...notes.values()].filter((n) => n.tenant_id === params[0]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return { rows: list.map((n) => ({ id: n.id, name: n.name, size: n.size, created_at: n.created_at, updated_at: n.updated_at })) };
      }
      return { rows: [] };
    },
    async end(): Promise<void> {
      pool.closeCount += 1;
    },
  };
  return pool;
}

test('PostgresScheduleStore save/get/list/remove with tenant filter', async () => {
  const store = new PostgresScheduleStore({ pool: schedPool() });
  await store.save({ id: 's1', tenantId: 't1', name: '每日简报', kind: 'cron', cron: '0 6 * * *', nextFireAt: '2026-05-24T06:00:00Z', version: 1, runs: 0 });
  await store.save({ id: 's2', tenantId: 't2', name: 'other', kind: 'once' });
  const got = await store.get('s1');
  assert.ok(got);
  assert.equal(got.name, '每日简报');
  const t1 = await store.list({ tenantId: 't1' });
  assert.equal(t1.length, 1);
  const [first] = t1;
  assert.ok(first);
  assert.equal(first.id, 's1');
  assert.equal(await store.remove('s1'), true);
  assert.equal(await store.get('s1'), null);
});

test('PostgresScheduleStore filters by user, handles jsonb rows, false removes, and closes the pool', async () => {
  const pool = schedPool();
  const store = new PostgresScheduleStore({ pool });
  await store.save({ id: 's1', tenantId: 't1', userId: 'u1', name: '用户 1', kind: 'once', runs: 2 });
  await store.save({ id: 's2', tenantId: 't1', userId: 'u2', name: '用户 2', kind: 'once' });

  const u1 = await store.list({ tenantId: 't1', userId: 'u1' });
  assert.deepEqual(u1.map((item) => item.id), ['s1']);
  assert.equal(await store.remove('missing'), false);
  await store.close();
  assert.equal(pool.closeCount, 1);

  const jsonbStore = new PostgresScheduleStore({
    pool: {
      async query(text: string) {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('SELECT schedule_json FROM schedules WHERE id=')) {
          return { rows: [{ schedule_json: { id: 'jsonb', tenantId: 't1', name: 'jsonb row' } }] };
        }
        return { rows: [] };
      },
    },
  });
  assert.deepEqual(await jsonbStore.get('jsonb'), { id: 'jsonb', tenantId: 't1', name: 'jsonb row' });
});

test('PostgresMemoryStore appendMemoryFact -> readMainMemory (tenant-scoped)', async () => {
  const store = new PostgresMemoryStore({ pool: memPool() });
  await store.appendMemoryFact('x', { key: '部署', value: '用 KCW_STORE=postgres', scope: 'project' }, { tenantId: 't1', userId: 'u1' });
  const md = await store.readMainMemory('x', { tenantId: 't1' });
  assert.match(md, /部署/);
  assert.match(md, /用 KCW_STORE=postgres/);
  const other = await store.readMainMemory('x', { tenantId: 't2' });
  assert.equal(other, '', 'other tenant sees no facts');
});

test('PostgresMemoryStore validates facts, normalizes scope, clips body, builds context, and closes the pool', async () => {
  const pool = memPool();
  const store = new PostgresMemoryStore({
    pool,
    now: () => new Date('2026-06-01T02:03:04.000Z'),
  });

  await assert.rejects(() => store.appendMemoryFact('x', { key: '', value: 'v' }), /key is required/);
  await assert.rejects(() => store.appendMemoryFact('x', { key: 'bad*key', value: 'v' }), /invalid characters/);
  await assert.rejects(() => store.appendMemoryFact('x', { key: 'ok', value: '' }), /value is required/);
  const fact = await store.appendMemoryFact('x', { key: '偏好', value: '保留真实证据', scope: 'unknown-scope' }, { tenantId: 't1', userId: 'u1', traceId: 'trace-1' });
  assert.deepEqual(fact.fact, { key: '偏好', value: '保留真实证据', scope: 'project' });

  const firstPath = await store.writeMemoryNote('x', 'clip.md', 'x'.repeat(70 * 1024), { tenantId: 't1', userId: 'u1' });
  const secondPath = await store.writeMemoryNote('x', 'clip.md', '更新', { tenantId: 't1', userId: 'u1' });
  assert.equal(secondPath, firstPath, 'note upsert keeps the first generated id');
  assert.equal(await store.readMemoryNote('x', 'clip.md', { tenantId: 't1' }), '更新');

  const block = await store.buildMemorySystemBlock('x', { maxBytes: 128, context: { tenantId: 't1' } });
  assert.match(block, /Agent Cowork/);
  assert.match(block, /偏好/);
  const loaded = await store.loadMemoryContext('x', { maxBytes: 128, context: { tenantId: 't1' } });
  assert.equal(loaded.enabled, true);
  assert.ok(loaded.bytes <= 512, 'memory system block keeps the documented minimum byte budget');
  assert.deepEqual(loaded.notes.map((note) => note.name), ['clip.md']);

  await store.close();
  assert.equal(pool.closeCount, 1);
});

test('PostgresMemoryStore accepts jsonb fact rows and returns an empty system block when memory is empty', async () => {
  const jsonbStore = new PostgresMemoryStore({
    pool: {
      async query(text: string) {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('SELECT fact_json FROM memory_facts WHERE tenant_id=')) {
          return { rows: [{ fact_json: { key: 'jsonb', value: 'direct object', scope: 'user' } }] };
        }
        if (t.startsWith('SELECT id, name')) return { rows: [] };
        return { rows: [] };
      },
    },
  });
  assert.match(await jsonbStore.readMainMemory('x', { tenantId: 't1' }), /direct object/);

  const emptyStore = new PostgresMemoryStore({ pool: memPool() });
  assert.equal(await emptyStore.buildMemorySystemBlock('x', { context: { tenantId: 'missing' } }), '');
  assert.deepEqual(await emptyStore.loadMemoryContext('x', { context: { tenantId: 'missing' } }), {
    enabled: false,
    bytes: 0,
    text: '',
    notes: [],
  });
});

test('PostgresMemoryStore note write/read/list round-trip', async () => {
  const store = new PostgresMemoryStore({ pool: memPool() });
  await store.writeMemoryNote('x', 'guide.md', '# 指南\n内容', { tenantId: 't1', userId: 'u1' });
  assert.equal(await store.readMemoryNote('x', 'guide.md', { tenantId: 't1' }), '# 指南\n内容');
  const notes = await store.listMemoryNotes('x', { tenantId: 't1' });
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.ok(note);
  assert.equal(note.name, 'guide.md');
  assert.ok(note.size > 0);
  await assert.rejects(() => store.readMemoryNote('x', '../evil', { tenantId: 't1' }), /Invalid memory note name/);
});

test('Postgres adapters without pool throw on first query', async () => {
  await assert.rejects(() => new PostgresScheduleStore({}).get('s'), /pool or connectionString/);
  await assert.rejects(() => new PostgresMemoryStore({}).readMainMemory('x', {}), /pool or connectionString/);
});

test('PostgresScheduleStore rejects unsafe table names', () => {
  assert.throws(
    () => new PostgresScheduleStore({ pool: schedPool(), table: 'schedules;select memory_facts' }),
    /invalid table name/,
  );
});
