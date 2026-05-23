import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresScheduleStore } from '../src/storage/postgres-schedule-store.js';
import { PostgresMemoryStore } from '../src/storage/postgres-memory-store.js';

function schedPool() {
  const rows = new Map();
  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO schedules')) {
        const rec = JSON.parse(params[16]);
        rows.set(rec.id, { tenant_id: params[1], user_id: params[2], schedule_json: params[16] });
        return { rowCount: 1 };
      }
      if (t.startsWith('SELECT schedule_json FROM schedules WHERE id=')) {
        const r = rows.get(params[0]);
        return { rows: r ? [{ schedule_json: r.schedule_json }] : [] };
      }
      if (t.startsWith('SELECT schedule_json FROM schedules')) {
        let list = [...rows.values()];
        if (t.includes('tenant_id=$1')) list = list.filter((r) => r.tenant_id === params[0]);
        return { rows: list.map((r) => ({ schedule_json: r.schedule_json })) };
      }
      if (t.startsWith('DELETE FROM schedules WHERE id=')) {
        const had = rows.has(params[0]); rows.delete(params[0]); return { rowCount: had ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

function memPool() {
  const facts = [];
  const notes = new Map();
  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO memory_facts')) { facts.push({ id: params[0], tenant_id: params[1], created_at: params[7], fact_json: params[9] }); return { rowCount: 1 }; }
      if (t.startsWith('SELECT fact_json FROM memory_facts WHERE tenant_id=')) {
        const list = facts.filter((f) => f.tenant_id === params[0]).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));
        return { rows: list.map((f) => ({ fact_json: f.fact_json })) };
      }
      if (t.startsWith('SELECT id, created_at FROM memory_notes WHERE tenant_id=')) { const n = notes.get(`${params[0]}|${params[1]}`); return { rows: n ? [{ id: n.id, created_at: n.created_at }] : [] }; }
      if (t.startsWith('INSERT INTO memory_notes')) { notes.set(`${params[1]}|${params[4]}`, { id: params[0], tenant_id: params[1], name: params[4], body: params[5], size: params[6], created_at: params[7], updated_at: params[8] }); return { rowCount: 1 }; }
      if (t.startsWith('SELECT body FROM memory_notes WHERE tenant_id=')) { const n = notes.get(`${params[0]}|${params[1]}`); return { rows: n ? [{ body: n.body }] : [] }; }
      if (t.startsWith('SELECT id, name, size, created_at, updated_at FROM memory_notes WHERE tenant_id=')) {
        const list = [...notes.values()].filter((n) => n.tenant_id === params[0]).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return { rows: list.map((n) => ({ id: n.id, name: n.name, size: n.size, created_at: n.created_at, updated_at: n.updated_at })) };
      }
      return { rows: [] };
    },
  };
}

test('PostgresScheduleStore save/get/list/remove with tenant filter', async () => {
  const store = new PostgresScheduleStore({ pool: schedPool() });
  await store.save({ id: 's1', tenantId: 't1', name: '每日简报', kind: 'cron', cron: '0 6 * * *', nextFireAt: '2026-05-24T06:00:00Z', version: 1, runs: 0 });
  await store.save({ id: 's2', tenantId: 't2', name: 'other', kind: 'once' });
  const got = await store.get('s1');
  assert.equal(got.name, '每日简报');
  const t1 = await store.list({ tenantId: 't1' });
  assert.equal(t1.length, 1);
  assert.equal(t1[0].id, 's1');
  assert.equal(await store.remove('s1'), true);
  assert.equal(await store.get('s1'), null);
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

test('PostgresMemoryStore note write/read/list round-trip', async () => {
  const store = new PostgresMemoryStore({ pool: memPool() });
  await store.writeMemoryNote('x', 'guide.md', '# 指南\n内容', { tenantId: 't1', userId: 'u1' });
  assert.equal(await store.readMemoryNote('x', 'guide.md', { tenantId: 't1' }), '# 指南\n内容');
  const notes = await store.listMemoryNotes('x', { tenantId: 't1' });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].name, 'guide.md');
  assert.ok(notes[0].size > 0);
  await assert.rejects(() => store.readMemoryNote('x', '../evil', { tenantId: 't1' }), /Invalid memory note name/);
});

test('Postgres adapters without pool throw on first query', async () => {
  await assert.rejects(() => new PostgresScheduleStore({}).get('s'), /pool or connectionString/);
  await assert.rejects(() => new PostgresMemoryStore({}).readMainMemory('x', {}), /pool or connectionString/);
});
