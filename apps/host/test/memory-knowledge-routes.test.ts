import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { upsertKnowledgeItem } from '../src/memory/knowledge-store.js';
import { bind, close, jsonRequest, recordValue, tempRoot } from './helpers/host-http.js';

function seedKnowledge(root: string): void {
  upsertKnowledgeItem(root, { topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.95 }, { confidenceThreshold: 0.7 });
  upsertKnowledgeItem(root, { topic: '八卦', title: '待确认', content: '也许喜欢咖啡', confidence: 0.3 }, { confidenceThreshold: 0.7 });
}

test('GET /api/memory/knowledge lists active + pending; ?status filters', async () => {
  const trustedRoot = tempRoot('kcw-kroute-');
  seedKnowledge(trustedRoot);
  const server = createServer({ requireAuth: false, trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const all = await jsonRequest(base, '/api/memory/knowledge');
    const allItems = recordValue(all.body, 'knowledge list').items as unknown[];
    assert.equal(allItems.length, 2);

    const active = await jsonRequest(base, '/api/memory/knowledge?status=active');
    const activeItems = recordValue(active.body, 'active list').items as Array<{ content: string }>;
    assert.equal(activeItems.length, 1);
    assert.match(String(activeItems[0]?.content), /Phoenix-7/);

    const pending = await jsonRequest(base, '/api/memory/knowledge?status=pending');
    assert.equal((recordValue(pending.body, 'pending list').items as unknown[]).length, 1);
  } finally {
    await close(server);
  }
});

test('POST /api/memory/knowledge/approve moves a pending item to active', async () => {
  const trustedRoot = tempRoot('kcw-kroute-');
  seedKnowledge(trustedRoot);
  const server = createServer({ requireAuth: false, trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const pending = await jsonRequest(base, '/api/memory/knowledge?status=pending');
    const id = (recordValue(pending.body, 'pending').items as Array<{ id: string }>)[0]?.id;
    assert.ok(id);
    const approve = await jsonRequest(base, '/api/memory/knowledge/approve', { method: 'POST', body: { id } });
    assert.equal(approve.status, 200);
    assert.equal((recordValue((await jsonRequest(base, '/api/memory/knowledge?status=active')).body, 'active').items as unknown[]).length, 2);
    // 未知 id → 404
    const bad = await jsonRequest(base, '/api/memory/knowledge/approve', { method: 'POST', body: { id: 'nope' } });
    assert.equal(bad.status, 404);
  } finally {
    await close(server);
  }
});

test('DELETE /api/memory/knowledge/:id removes a mis-extracted item', async () => {
  const trustedRoot = tempRoot('kcw-kroute-');
  seedKnowledge(trustedRoot);
  const server = createServer({ requireAuth: false, trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const id = (recordValue((await jsonRequest(base, '/api/memory/knowledge?status=active')).body, 'active').items as Array<{ id: string }>)[0]?.id;
    assert.ok(id);
    const del = await jsonRequest(base, `/api/memory/knowledge/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((recordValue((await jsonRequest(base, '/api/memory/knowledge?status=active')).body, 'active').items as unknown[]).length, 0);
  } finally {
    await close(server);
  }
});
