import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresMemoryStore, type PgPool, type PgResult } from '../src/storage/postgres-memory-store.js';

type FactRow = { tenantId: unknown; userId: unknown; createdAt: unknown; id: unknown; factJson: string };
type NoteRow = {
  id: unknown;
  tenantId: unknown;
  userId: unknown;
  name: string;
  body: string;
  size: number;
  createdAt: unknown;
  updatedAt: unknown;
};
type QueryCall = { text: string; params: unknown[] };
type FakePool = PgPool & { calls: QueryCall[] };

function fakePool(): FakePool {
  const facts: FactRow[] = [];
  const notes = new Map<string, NoteRow>();
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []): Promise<PgResult> {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ text: sql, params: [...params] });
      if (sql.startsWith('INSERT INTO memory_facts')) {
        facts.push({ tenantId: params[1], userId: params[2], createdAt: params[7], id: params[0], factJson: String(params[9] || '') });
        return { rowCount: 1 };
      }
      if (sql.startsWith('SELECT fact_json FROM memory_facts')) {
        const rows = facts
          .filter((row) => row.tenantId === params[0] && (!sql.includes('user_id=$2') || row.userId === params[1]))
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
        return { rows: rows.map((row) => ({ fact_json: row.factJson })) };
      }
      if (sql.startsWith('SELECT id, created_at FROM memory_notes')) {
        const row = notes.get(`${String(params[0])}|${String(params[2] ?? params[1])}`);
        return { rows: row && (!sql.includes('user_id=$2') || row.userId === params[1]) ? [{ id: row.id, created_at: row.createdAt }] : [] };
      }
      if (sql.startsWith('INSERT INTO memory_notes')) {
        const row: NoteRow = {
          id: params[0], tenantId: params[1], userId: params[2], name: String(params[4]),
          body: String(params[5]), size: Number(params[6]), createdAt: params[7], updatedAt: params[8],
        };
        notes.set(`${String(row.tenantId)}|${row.name}`, row);
        return { rowCount: 1 };
      }
      if (sql.startsWith('SELECT body FROM memory_notes')) {
        const row = notes.get(`${String(params[0])}|${String(params[2] ?? params[1])}`);
        return { rows: row && (!sql.includes('user_id=$2') || row.userId === params[1]) ? [{ body: row.body }] : [] };
      }
      if (sql.startsWith('SELECT id, name, size, created_at, updated_at FROM memory_notes')) {
        const rows = [...notes.values()]
          .filter((row) => row.tenantId === params[0] && (!sql.includes('user_id=$2') || row.userId === params[1]))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { rows: rows.map((row) => ({ id: row.id, name: row.name, size: row.size, created_at: row.createdAt, updated_at: row.updatedAt })) };
      }
      return { rows: [] };
    },
  };
}

test('PostgreSQL fake proves exact owner SQL and logical/physical note separation', async () => {
  const pool = fakePool();
  const store = new PostgresMemoryStore({ pool });
  const alice = { tenantId: 'shared', userId: 'alice' };
  const bob = { tenantId: 'shared', userId: 'bob' };

  await assert.rejects(() => store.readMainMemory('root'), /memory owner tenantId is required/);
  await store.appendMemoryFact('root', { key: 'owner', value: 'alice fact', scope: 'project' }, alice);
  await store.appendMemoryFact('root', { key: 'owner', value: 'bob fact', scope: 'project' }, bob);
  assert.match(await store.readMainMemory('root', alice), /alice fact/);
  assert.doesNotMatch(await store.readMainMemory('root', alice), /bob fact/);

  await store.writeMemoryNote('root', 'profile.md', 'alice profile', alice);
  await store.writeMemoryNote('root', 'profile.md', 'bob profile', bob);
  assert.equal(await store.readMemoryNote('root', 'profile.md', alice), 'alice profile');
  assert.equal(await store.readMemoryNote('root', 'profile.md', bob), 'bob profile');
  assert.deepEqual((await store.listMemoryNotes('root', alice)).map((note) => note.name), ['profile.md']);

  const factSelect = pool.calls.find((call) => call.text.startsWith('SELECT fact_json'));
  assert.match(factSelect?.text || '', /WHERE tenant_id=\$1 AND user_id=\$2/);
  const noteSelects = pool.calls.filter((call) => /FROM memory_notes WHERE/.test(call.text));
  assert.ok(noteSelects.every((call) => /tenant_id=\$1 AND user_id=\$2/.test(call.text)));
  const noteInserts = pool.calls.filter((call) => call.text.startsWith('INSERT INTO memory_notes'));
  assert.equal(noteInserts.length, 2);
  assert.ok(noteInserts.every((call) => /^v1-[a-f0-9]{64}--profile\.md$/.test(String(call.params[4]))));
  assert.ok(noteInserts[0]?.params[4] !== noteInserts[1]?.params[4]);
  assert.ok(noteInserts.every((call) => call.params[4] !== 'profile.md'));
});
