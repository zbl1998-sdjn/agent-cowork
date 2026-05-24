import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresConversationStore } from '../src/storage/postgres-conversation-store.js';

// In-memory mock pool that understands the store's SQL well enough to verify
// isolation, search, pagination and upsert semantics.
function convPool() {
  const rows = new Map(); // tenant|user|id -> record
  const key = (t, u, i) => `${t}|${u}|${i}`;
  return {
    async query(text, params = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO conversations')) {
        const [tenant, user, id, title, pinned, messagesJson, branchesJson, activeBranchId, createdAt, updatedAt] = params;
        const k = key(tenant, user, id);
        const existing = rows.get(k);
        const rec = {
          tenant_id: tenant, user_id: user, id, title, pinned,
          messages: JSON.parse(messagesJson),
          branches: JSON.parse(branchesJson),
          active_branch_id: activeBranchId,
          created_at: existing ? existing.created_at : createdAt,
          updated_at: updatedAt,
        };
        rows.set(k, rec);
        return {
          rows: [{
            id, title, pinned, message_count: rec.messages.length,
            branch_count: rec.branches.length, active_branch_id: rec.active_branch_id,
            created_at: rec.created_at, updated_at: rec.updated_at,
          }],
          rowCount: 1,
        };
      }
      if (t.startsWith('SELECT COUNT(*)')) {
        const [tenant, user, like] = params;
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user);
        if (like) { const q = like.replace(/%/g, '').toLowerCase(); list = list.filter((r) => (r.title || '').toLowerCase().includes(q)); }
        return { rows: [{ total: list.length }] };
      }
      if (t.includes('OFFSET')) { // paginated query items
        const tenant = params[0], user = params[1];
        let like = null, lim, off;
        if (params.length === 5) { like = params[2]; lim = params[3]; off = params[4]; }
        else { lim = params[2]; off = params[3]; }
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user);
        if (like) { const q = like.replace(/%/g, '').toLowerCase(); list = list.filter((r) => (r.title || '').toLowerCase().includes(q)); }
        list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        list = list.slice(off, off + lim);
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, message_count: r.messages.length, branch_count: (r.branches || []).length, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.includes('AND id=$3') && t.startsWith('SELECT id, title, pinned, messages')) { // get
        const r = rows.get(key(params[0], params[1], params[2]));
        return { rows: r ? [{ id: r.id, title: r.title, pinned: r.pinned, messages: r.messages, branches: r.branches, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at }] : [] };
      }
      if (t.startsWith('SELECT id, title, pinned, messages')) { // listFull
        const tenant = params[0], user = params[1];
        const limit = params.length > 2 ? params[2] : undefined;
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        if (typeof limit === 'number') list = list.slice(0, limit);
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, messages: r.messages, branches: r.branches, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.startsWith('SELECT id, title, pinned, jsonb_array_length')) { // list summaries
        const tenant = params[0], user = params[1];
        const list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, message_count: r.messages.length, branch_count: (r.branches || []).length, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.startsWith('DELETE FROM conversations')) {
        const k = key(params[0], params[1], params[2]); const had = rows.has(k); rows.delete(k);
        return { rowCount: had ? 1 : 0 };
      }
      return { rows: [] };
    },
  };
}

test('PG conversations: save/get/list/query/remove with tenant+user isolation', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  const a = { tenantId: 't1', userId: 'u1' };
  const b = { tenantId: 't2', userId: 'u1' };
  await store.save('/r', { id: 'c1', title: 'Alpha', messages: [{ role: 'user', text: 'hi' }] }, a);
  await store.save('/r', { id: 'c2', title: 'Beta', messages: [] }, a);
  await store.save('/r', { id: 'c3', title: 'Other', messages: [] }, b);

  assert.equal((await store.list('/r', a)).length, 2);
  const listB = await store.list('/r', b);
  assert.equal(listB.length, 1);
  assert.equal(listB[0].id, 'c3');

  const c1 = await store.get('/r', 'c1', a);
  assert.equal(c1.title, 'Alpha');
  assert.equal(c1.messages.length, 1);
  assert.equal(await store.get('/r', 'c1', b), null);

  const search = await store.query('/r', a, { q: 'alp', limit: 10, offset: 0 });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, 'c1');

  const page = await store.query('/r', a, { q: '', limit: 1, offset: 0 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);

  const full = await store.listFull('/r', a, { limit: 1 });
  assert.equal(full.length, 1);
  assert.ok(Array.isArray(full[0].messages));

  assert.equal(await store.remove('/r', 'c1', a), true);
  assert.equal(await store.remove('/r', 'c1', a), false);
  assert.equal((await store.list('/r', a)).length, 1);
});

test('PG conversations preserve branch metadata', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  const ctx = { tenantId: 't1', userId: 'u1' };
  const branches = [
    { id: 'main', title: '主线', messages: [{ id: 'u1', role: 'user', text: 'old' }] },
    { id: 'b1', title: '分支 1', parentBranchId: 'main', baseMessageId: 'u1', messages: [{ id: 'u2', role: 'user', text: 'new' }] },
  ];

  const summary = await store.save('/r', { id: 'c1', title: 'Branchy', messages: branches[1].messages, activeBranchId: 'b1', branches }, ctx);
  assert.equal(summary.branchCount, 2);
  assert.equal(summary.activeBranchId, 'b1');

  const full = await store.get('/r', 'c1', ctx);
  assert.equal(full.activeBranchId, 'b1');
  assert.deepEqual(full.branches.map((branch) => branch.id), ['main', 'b1']);
});

test('PG conversations: invalid id is rejected', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  await assert.rejects(
    () => store.save('/r', { id: '../x', messages: [] }, { tenantId: 't1', userId: 'u1' }),
    /invalid conversation id/,
  );
});
