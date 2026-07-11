import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteMemoryStore } from '../src/memory/sqlite-memory-store.js';

const require = createRequire(import.meta.url);
const sqliteAvailable = (() => {
  try { require('node:sqlite'); return true; } catch { return false; }
})();
const alice = { tenantId: 'shared', userId: 'alice' };
const bob = { tenantId: 'shared', userId: 'bob' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sqlite-memory-owner-'));
}

test('SQLite memory filters facts and notes by exact tenant and user without a schema change', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const store = new SqliteMemoryStore({ dbPath: path.join(root, 'state.sqlite') });

  assert.throws(() => store.readMainMemory(root), /memory owner tenantId is required/);
  store.appendMemoryFact(root, { key: 'owner', value: 'alice fact', scope: 'project' }, alice);
  store.appendMemoryFact(root, { key: 'owner', value: 'bob fact', scope: 'project' }, bob);
  assert.match(store.readMainMemory(root, alice), /alice fact/);
  assert.doesNotMatch(store.readMainMemory(root, alice), /bob fact/);
  assert.match(store.readMainMemory(root, bob), /bob fact/);

  store.writeMemoryNote(root, 'profile.md', 'alice profile', alice);
  store.writeMemoryNote(root, 'profile.md', 'bob profile', bob);
  assert.equal(store.readMemoryNote(root, 'profile.md', alice), 'alice profile');
  assert.equal(store.readMemoryNote(root, 'profile.md', bob), 'bob profile');
  assert.deepEqual(store.listMemoryNotes(root, alice).map((note) => note.name), ['profile.md']);
  assert.deepEqual(store.listMemoryNotes(root, bob).map((note) => note.name), ['profile.md']);

  const names = store.db.prepare('SELECT name FROM memory_notes ORDER BY name').all() as Array<{ name: string }>;
  assert.equal(names.length, 2);
  assert.ok(names.every(({ name }) => /^v1-[a-f0-9]{64}--profile\.md$/.test(name)));
  assert.ok(names[0]?.name !== names[1]?.name);
});

test('SQLite legacy logical notes are restricted to the explicit local owner', { skip: !sqliteAvailable }, () => {
  const root = tempRoot();
  const store = new SqliteMemoryStore({ dbPath: path.join(root, 'state.sqlite') });
  store.db.prepare(`
    INSERT INTO memory_notes (
      id, tenant_id, user_id, trace_id, name, body, size,
      created_at, updated_at, note_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy', 'tenant_local', 'user_local', null, 'legacy.md', 'legacy body', 11,
    '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', '{}',
  );

  assert.equal(store.readMemoryNote(root, 'legacy.md', { tenantId: 'tenant_local', userId: 'user_local' }), 'legacy body');
  assert.equal(store.readMemoryNote(root, 'legacy.md', { tenantId: 'tenant_local', userId: 'alice' }), null);
  assert.deepEqual(store.listMemoryNotes(root, { tenantId: 'tenant_local', userId: 'alice' }), []);
});
