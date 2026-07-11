import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { PostgresConversationStore } from '../src/storage/postgres-conversation-store.js';
import type { PgPool } from '../src/storage/postgres-conversation-store.js';
import type { ConversationBranch } from '../src/storage/conversation-store.js';

type ConversationRow = {
  tenant_id: unknown;
  user_id: unknown;
  workspace_key: unknown;
  id: unknown;
  title: unknown;
  pinned: unknown;
  messages: unknown[];
  branches: ConversationBranch[];
  active_branch_id: unknown;
  created_at: unknown;
  updated_at: unknown;
};

// In-memory mock pool that understands the store's SQL well enough to verify
// isolation, search, pagination and upsert semantics.
function convPool(initialRows: ConversationRow[] = []): PgPool {
  const rows = new Map<string, ConversationRow>(); // tenant|user|workspace|id -> record
  const key = (...parts: unknown[]) => parts.map((part) => String(part ?? '')).join('|');
  for (const row of initialRows) {
    rows.set(key(row.tenant_id, row.user_id, row.workspace_key, row.id), row);
  }
  return {
    async query(text: string, params: unknown[] = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      if (t.startsWith('INSERT INTO conversations')) {
        const [tenant, user, workspace, id, title, pinned, messagesJson, branchesJson, activeBranchId, createdAt, updatedAt] = params;
        const k = key(tenant, user, workspace, id);
        const existing = rows.get(k);
        const rec = {
          tenant_id: tenant, user_id: user, workspace_key: workspace, id, title, pinned,
          messages: JSON.parse(String(messagesJson ?? '[]')) as unknown[],
          branches: JSON.parse(String(branchesJson ?? '[]')) as ConversationBranch[],
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
        const [tenant, user, workspace, like] = params;
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user && r.workspace_key === workspace);
        if (typeof like === 'string' && like) { const q = like.replace(/%/g, '').toLowerCase(); list = list.filter((r) => String(r.title || '').toLowerCase().includes(q)); }
        return { rows: [{ total: list.length }] };
      }
      if (t.includes('OFFSET')) { // paginated query items
        const tenant = params[0], user = params[1], workspace = params[2];
        let like: unknown = null;
        let lim: number;
        let off: number;
        if (params.length === 6) { like = params[3]; lim = Number(params[4] ?? 0); off = Number(params[5] ?? 0); }
        else { lim = Number(params[3] ?? 0); off = Number(params[4] ?? 0); }
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user && r.workspace_key === workspace);
        if (typeof like === 'string' && like) { const q = like.replace(/%/g, '').toLowerCase(); list = list.filter((r) => String(r.title || '').toLowerCase().includes(q)); }
        list.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        list = list.slice(off, off + lim);
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, message_count: r.messages.length, branch_count: (r.branches || []).length, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.includes('AND id=$4') && t.startsWith('SELECT id, title, pinned, messages')) { // get
        const r = rows.get(key(params[0], params[1], params[2], params[3]));
        return { rows: r ? [{ id: r.id, title: r.title, pinned: r.pinned, messages: r.messages, branches: r.branches, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at }] : [] };
      }
      if (t.startsWith('SELECT id, title, pinned, messages')) { // listFull
        const tenant = params[0], user = params[1], workspace = params[2];
        const limit = params.length > 3 ? params[3] : undefined;
        let list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user && r.workspace_key === workspace).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        if (typeof limit === 'number') list = list.slice(0, limit);
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, messages: r.messages, branches: r.branches, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.startsWith('SELECT id, title, pinned, jsonb_array_length')) { // list summaries
        const tenant = params[0], user = params[1], workspace = params[2];
        const list = [...rows.values()].filter((r) => r.tenant_id === tenant && r.user_id === user && r.workspace_key === workspace).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        return { rows: list.map((r) => ({ id: r.id, title: r.title, pinned: r.pinned, message_count: r.messages.length, branch_count: (r.branches || []).length, active_branch_id: r.active_branch_id, created_at: r.created_at, updated_at: r.updated_at })) };
      }
      if (t.startsWith('DELETE FROM conversations')) {
        const k = key(params[0], params[1], params[2], params[3]); const had = rows.has(k); rows.delete(k);
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
  const [onlyB] = listB;
  assert.ok(onlyB);
  assert.equal(onlyB.id, 'c3');

  const c1 = await store.get('/r', 'c1', a);
  assert.ok(c1);
  assert.equal(c1.title, 'Alpha');
  assert.equal(c1.messages.length, 1);
  assert.equal(await store.get('/r', 'c1', b), null);

  const search = await store.query('/r', a, { q: 'alp', limit: 10, offset: 0 });
  assert.equal(search.total, 1);
  const [firstSearch] = search.items;
  assert.ok(firstSearch);
  assert.equal(firstSearch.id, 'c1');

  const page = await store.query('/r', a, { q: '', limit: 1, offset: 0 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);

  const full = await store.listFull('/r', a, { limit: 1 });
  assert.equal(full.length, 1);
  const [fullFirst] = full;
  assert.ok(fullFirst);
  assert.ok(Array.isArray(fullFirst.messages));

  assert.equal(await store.remove('/r', 'c1', a), true);
  assert.equal(await store.remove('/r', 'c1', a), false);
  assert.equal((await store.list('/r', a)).length, 1);
});

test('PG conversations: same tenant/user/id is isolated by workspace', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  const ctx = { tenantId: 't1', userId: 'u1' };

  await store.save('/r-a', { id: 'shared', title: 'Workspace A', messages: [{ role: 'user', text: 'a' }] }, ctx);

  assert.equal(await store.get('/r-b', 'shared', ctx), null);
  assert.equal((await store.list('/r-b', ctx)).length, 0);

  await store.save('/r-b', { id: 'shared', title: 'Workspace B', messages: [{ role: 'user', text: 'b' }] }, ctx);

  const fromA = await store.get('/r-a', 'shared', ctx);
  const fromB = await store.get('/r-b', 'shared', ctx);
  assert.ok(fromA);
  assert.ok(fromB);
  assert.equal(fromA.title, 'Workspace A');
  assert.equal(fromB.title, 'Workspace B');
  assert.equal((await store.query('/r-a', ctx, { q: 'Workspace', limit: 10, offset: 0 })).total, 1);
  assert.equal((await store.query('/r-b', ctx, { q: 'Workspace', limit: 10, offset: 0 })).total, 1);
});

test('PG conversations preserve branch metadata', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  const ctx = { tenantId: 't1', userId: 'u1' };
  const branches = [
    { id: 'main', title: '主线', messages: [{ id: 'u1', role: 'user', text: 'old' }] },
    { id: 'b1', title: '分支 1', parentBranchId: 'main', baseMessageId: 'u1', messages: [{ id: 'u2', role: 'user', text: 'new' }] },
  ];
  const branchB = branches[1];
  assert.ok(branchB);

  const summary = await store.save('/r', { id: 'c1', title: 'Branchy', messages: branchB.messages, activeBranchId: 'b1', branches }, ctx);
  assert.equal(summary.branchCount, 2);
  assert.equal(summary.activeBranchId, 'b1');

  const full = await store.get('/r', 'c1', ctx);
  assert.ok(full);
  assert.ok(full.branches);
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

test('PG conversations keep long tenant and user owners exact across every operation', async () => {
  const store = new PostgresConversationStore({ pool: convPool() });
  const pairs = [
    [
      { tenantId: 'tenant-long', userId: `${'u'.repeat(96)}A` },
      { tenantId: 'tenant-long', userId: `${'u'.repeat(96)}B` },
    ],
    [
      { tenantId: `${'t'.repeat(96)}A`, userId: 'same-user' },
      { tenantId: `${'t'.repeat(96)}B`, userId: 'same-user' },
    ],
  ] as const;

  for (const [ownerA, ownerB] of pairs) {
    await store.save('/r', { id: 'shared', title: 'Alice secret', messages: [{ role: 'user', text: 'secret' }] }, ownerA);
    assert.equal(await store.get('/r', 'shared', ownerB), null);
    assert.deepEqual(await store.list('/r', ownerB), []);
    assert.deepEqual(await store.listFull('/r', ownerB), []);
    assert.equal((await store.query('/r', ownerB, { q: 'Alice' })).total, 0);
    assert.equal(await store.remove('/r', 'shared', ownerB), false);

    await store.save('/r', { id: 'shared', title: 'Bob private', messages: [] }, ownerB);
    assert.equal((await store.get('/r', 'shared', ownerA))?.title, 'Alice secret');
    assert.equal((await store.get('/r', 'shared', ownerB))?.title, 'Bob private');
    assert.equal(await store.remove('/r', 'shared', ownerB), true);
    assert.equal((await store.get('/r', 'shared', ownerA))?.title, 'Alice secret');
    assert.equal(await store.remove('/r', 'shared', ownerA), true);
  }
});

test('PG conversations fail closed against ambiguous rows written with a legacy workspace key', async () => {
  const trustedRoot = '/legacy-root';
  const legacyWorkspaceKey = crypto.createHash('sha256').update(path.resolve(trustedRoot)).digest('hex');
  const truncatedUser = 'u'.repeat(96);
  const legacyRow: ConversationRow = {
    tenant_id: 'tenant-long',
    user_id: truncatedUser,
    workspace_key: legacyWorkspaceKey,
    id: 'legacy-secret',
    title: 'Legacy Alice secret',
    pinned: false,
    messages: [{ role: 'user', text: 'secret' }],
    branches: [],
    active_branch_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
  const store = new PostgresConversationStore({ pool: convPool([legacyRow]) });

  for (const context of [
    { tenantId: 'tenant-long', userId: truncatedUser },
    { tenantId: 'tenant-long', userId: `${truncatedUser}A` },
  ]) {
    assert.equal(await store.get(trustedRoot, 'legacy-secret', context), null);
    assert.deepEqual(await store.list(trustedRoot, context), []);
    assert.deepEqual(await store.listFull(trustedRoot, context), []);
    assert.equal((await store.query(trustedRoot, context, { q: 'Legacy' })).total, 0);
    assert.equal(await store.remove(trustedRoot, 'legacy-secret', context), false);
  }
});
