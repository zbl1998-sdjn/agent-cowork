import assert from 'node:assert/strict';
import test from 'node:test';
import {
  upsertKnowledgeItem,
  listKnowledgeItems,
  setKnowledgeItemStatus,
  deleteKnowledgeItem,
} from '../src/memory/knowledge-store.js';
import { tempRoot } from './helpers/host-http.js';

const cand = (over = {}) => ({ topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.9, ...over });

test('high-confidence candidate is stored as an active knowledge item with provenance', () => {
  const root = tempRoot('kcw-know-');
  const res = upsertKnowledgeItem(root, cand(), { sourceConversationId: 'conv-A', confidenceThreshold: 0.7 });
  assert.equal(res.stored, true);
  assert.equal(res.status, 'active');
  const items = listKnowledgeItems(root);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'active');
  assert.match(String(items[0]?.content), /Phoenix-7/);
  assert.equal(items[0]?.provenance?.sourceConversationId, 'conv-A');
  assert.ok(items[0]?.provenance?.ts, 'provenance should carry a timestamp');
});

test('low-confidence candidate goes to the pending queue, not active', () => {
  const root = tempRoot('kcw-know-');
  const res = upsertKnowledgeItem(root, cand({ confidence: 0.4 }), { confidenceThreshold: 0.7 });
  assert.equal(res.status, 'pending');
  assert.equal(listKnowledgeItems(root, { status: 'active' }).length, 0);
  assert.equal(listKnowledgeItems(root, { status: 'pending' }).length, 1);
});

test('same topic+title merges/supersedes instead of duplicating (no pollution); confidence takes the max', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand({ content: '项目代号是 Phoenix-7', confidence: 0.75 }), { confidenceThreshold: 0.7 });
  upsertKnowledgeItem(root, cand({ content: '项目代号已更新为 Phoenix-8', confidence: 0.9 }), { confidenceThreshold: 0.7 });
  const items = listKnowledgeItems(root);
  assert.equal(items.length, 1, 'same topic+title must not create a duplicate');
  assert.match(String(items[0]?.content), /Phoenix-8/, 'content should be superseded by the newer value');
  assert.equal(items[0]?.confidence, 0.9);
});

test('DLP denies storing a secret-bearing candidate (never persists credentials)', () => {
  const root = tempRoot('kcw-know-');
  const secret = 'sk-livetestfake0000000000000000'; // allowlist-secret
  const res = upsertKnowledgeItem(root, cand({ title: '令牌', content: `我的部署令牌是 ${secret}` }), {});
  assert.equal(res.stored, false);
  assert.match(String(res.reason), /dlp|secret|敏感|密钥/i);
  assert.equal(listKnowledgeItems(root).length, 0);
});

test('active items are capped per scope; the oldest is evicted and reported (no silent unbounded growth)', () => {
  const root = tempRoot('kcw-know-');
  const evicted: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const res = upsertKnowledgeItem(
      root,
      cand({ title: `k${i}`, content: `v${i}`, confidence: 0.9 }),
      { confidenceThreshold: 0.7, maxActivePerScope: 3, now: new Date(2026, 0, 1, 0, i) },
    );
    if (res.evicted) evicted.push(...res.evicted.map((e) => e.title));
  }
  const active = listKnowledgeItems(root, { status: 'active' });
  assert.ok(active.length <= 3, `active items should be capped at 3, got ${active.length}`);
  assert.ok(evicted.includes('k0'), 'oldest item k0 should have been evicted');
  assert.equal(active.some((it) => it.title === 'k0'), false);
});

test('deleteKnowledgeItem removes an item (user can delete a mis-extracted memory)', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand(), { confidenceThreshold: 0.7 });
  const item = listKnowledgeItems(root)[0];
  assert.ok(item);
  assert.equal(deleteKnowledgeItem(root, String(item?.id)), true);
  assert.equal(listKnowledgeItems(root).length, 0);
  // 删不存在的 id 返回 false
  assert.equal(deleteKnowledgeItem(root, 'nope'), false);
});

test('setKnowledgeItemStatus approves a pending item into active', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand({ confidence: 0.3 }), { confidenceThreshold: 0.7 });
  const pending = listKnowledgeItems(root, { status: 'pending' })[0];
  assert.ok(pending);
  const ok = setKnowledgeItemStatus(root, String(pending?.id), 'active');
  assert.equal(ok, true);
  assert.equal(listKnowledgeItems(root, { status: 'active' }).length, 1);
  assert.equal(listKnowledgeItems(root, { status: 'pending' }).length, 0);
});
