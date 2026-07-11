import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  upsertKnowledgeItem,
  listKnowledgeItems,
  setKnowledgeItemStatus,
  deleteKnowledgeItem,
} from '../src/memory/knowledge-store.js';
import { memoryOwnerStorageKey } from '../src/memory/memory-owner.js';
import { tempRoot } from './helpers/host-http.js';

const cand = (over = {}) => ({ topic: '项目', title: '项目代号', content: '项目代号是 Phoenix-7', confidence: 0.9, ...over });
const owner = { tenantId: 'tenant_test', userId: 'user_test' };
const siblingOwner = { tenantId: 'tenant_test', userId: 'user_sibling' };

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function linkDirectory(target: string, linkPath: string): void {
  try { symlinkSync(target, linkPath, 'junction'); } catch { symlinkSync(target, linkPath, 'dir'); }
}

function knowledgePath(appDir: string, context = owner): string {
  return path.join(appDir, 'owners', memoryOwnerStorageKey(context), 'knowledge.json');
}

function validKnowledgeFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: [{
    id: 'know_test', topic: 'security', title: 'boundary', content: 'outside',
    confidence: 0.9, status: 'active', scope: 'project',
    provenance: { sourceConversationId: 'conv', ts: '2026-01-01T00:00:00.000Z' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  }] }), 'utf8');
}

test('high-confidence candidate is stored as an active knowledge item with provenance', () => {
  const root = tempRoot('kcw-know-');
  const res = upsertKnowledgeItem(root, cand(), { sourceConversationId: 'conv-A', confidenceThreshold: 0.7, context: owner });
  assert.equal(res.stored, true);
  assert.equal(res.status, 'active');
  const items = listKnowledgeItems(root, { context: owner });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'active');
  assert.match(String(items[0]?.content), /Phoenix-7/);
  assert.equal(items[0]?.provenance?.sourceConversationId, 'conv-A');
  assert.ok(items[0]?.provenance?.ts, 'provenance should carry a timestamp');
});

test('low-confidence candidate goes to the pending queue, not active', () => {
  const root = tempRoot('kcw-know-');
  const res = upsertKnowledgeItem(root, cand({ confidence: 0.4 }), { confidenceThreshold: 0.7, context: owner });
  assert.equal(res.status, 'pending');
  assert.equal(listKnowledgeItems(root, { status: 'active', context: owner }).length, 0);
  assert.equal(listKnowledgeItems(root, { status: 'pending', context: owner }).length, 1);
});

test('same topic+title merges/supersedes instead of duplicating (no pollution); confidence takes the max', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand({ content: '项目代号是 Phoenix-7', confidence: 0.75 }), { confidenceThreshold: 0.7, context: owner });
  upsertKnowledgeItem(root, cand({ content: '项目代号已更新为 Phoenix-8', confidence: 0.9 }), { confidenceThreshold: 0.7, context: owner });
  const items = listKnowledgeItems(root, { context: owner });
  assert.equal(items.length, 1, 'same topic+title must not create a duplicate');
  assert.match(String(items[0]?.content), /Phoenix-8/, 'content should be superseded by the newer value');
  assert.equal(items[0]?.confidence, 0.9);
});

test('DLP denies storing a secret-bearing candidate (never persists credentials)', () => {
  const root = tempRoot('kcw-know-');
  const secret = 'sk-livetestfake0000000000000000'; // allowlist-secret
  const res = upsertKnowledgeItem(root, cand({ title: '令牌', content: `我的部署令牌是 ${secret}` }), { context: owner });
  assert.equal(res.stored, false);
  assert.match(String(res.reason), /dlp|secret|敏感|密钥/i);
  assert.equal(listKnowledgeItems(root, { context: owner }).length, 0);
});

test('active items are capped per scope; the oldest is evicted and reported (no silent unbounded growth)', () => {
  const root = tempRoot('kcw-know-');
  const evicted: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const res = upsertKnowledgeItem(
      root,
      cand({ title: `k${i}`, content: `v${i}`, confidence: 0.9 }),
      { confidenceThreshold: 0.7, maxActivePerScope: 3, now: new Date(2026, 0, 1, 0, i), context: owner },
    );
    if (res.evicted) evicted.push(...res.evicted.map((e) => e.title));
  }
  const active = listKnowledgeItems(root, { status: 'active', context: owner });
  assert.ok(active.length <= 3, `active items should be capped at 3, got ${active.length}`);
  assert.ok(evicted.includes('k0'), 'oldest item k0 should have been evicted');
  assert.equal(active.some((it) => it.title === 'k0'), false);
});

test('deleteKnowledgeItem removes an item (user can delete a mis-extracted memory)', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand(), { confidenceThreshold: 0.7, context: owner });
  const item = listKnowledgeItems(root, { context: owner })[0];
  assert.ok(item);
  assert.equal(deleteKnowledgeItem(root, String(item?.id), owner), true);
  assert.equal(listKnowledgeItems(root, { context: owner }).length, 0);
  // 删不存在的 id 返回 false
  assert.equal(deleteKnowledgeItem(root, 'nope', owner), false);
});

test('setKnowledgeItemStatus approves a pending item into active', () => {
  const root = tempRoot('kcw-know-');
  upsertKnowledgeItem(root, cand({ confidence: 0.3 }), { confidenceThreshold: 0.7, context: owner });
  const pending = listKnowledgeItems(root, { status: 'pending', context: owner })[0];
  assert.ok(pending);
  const ok = setKnowledgeItemStatus(root, String(pending?.id), 'active', owner);
  assert.equal(ok, true);
  assert.equal(listKnowledgeItems(root, { status: 'active', context: owner }).length, 1);
  assert.equal(listKnowledgeItems(root, { status: 'pending', context: owner }).length, 0);
});

test('knowledge store rejects a default .AgentCowork junction outside trustedRoot', () => {
  const root = tempRoot('kcw-know-jail-');
  const outside = tempRoot('kcw-know-outside-');
  validKnowledgeFile(knowledgePath(outside));
  linkDirectory(outside, path.join(root, '.AgentCowork'));

  assert.throws(
    () => listKnowledgeItems(root, { context: owner }),
    /symbolic link|junction|reparse|managed directory/i,
  );
});

test('knowledge store rejects an owner namespace junction to a sibling tenant scope', {
  skip: process.platform !== 'win32',
}, (t) => {
  const root = tempRoot('kcw-know-owner-junction-');
  const appDir = path.join(root, '.AgentCowork');
  const siblingFile = knowledgePath(appDir, siblingOwner);
  validKnowledgeFile(siblingFile);
  const ownerDir = path.dirname(knowledgePath(appDir, owner));
  try {
    symlinkSync(path.dirname(siblingFile), ownerDir, 'junction');
  } catch (error) {
    t.skip(`junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => listKnowledgeItems(root, { context: owner }),
    /symbolic link|junction|reparse|managed directory|managed path/i,
  );
});

test('knowledge store revalidates after mkdir before publishing into a swapped directory', (t) => {
  const root = tempRoot('kcw-know-swap-');
  const outside = tempRoot('kcw-know-swap-outside-');
  const appDir = path.join(root, '.AgentCowork');
  const displaced = path.join(root, '.AgentCowork-original');
  const ownerDir = path.dirname(knowledgePath(appDir));
  const outsideFile = knowledgePath(outside);
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && path.resolve(String(args[0])) === path.resolve(ownerDir)) {
      fs.renameSync(appDir, displaced);
      try {
        linkDirectory(outside, appDir);
      } catch (error) {
        fs.renameSync(displaced, appDir);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;

  try {
    assert.throws(
      () => upsertKnowledgeItem(root, cand(), { context: owner }),
      /changed|symbolic link|junction|reparse|managed directory/i,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true, 'test must exercise the post-mkdir directory swap');
  assert.equal(fs.existsSync(outsideFile), false);
});

test('knowledge store never follows a knowledge-file symlink', (t) => {
  const root = tempRoot('kcw-know-link-');
  const appDir = path.join(root, '.AgentCowork');
  const outsideFile = path.join(tempRoot('kcw-know-link-outside-'), 'outside.json');
  validKnowledgeFile(outsideFile);
  const file = knowledgePath(appDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    symlinkSync(outsideFile, file, 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }
  assert.throws(
    () => listKnowledgeItems(root, { context: owner }),
    /symbolic link|reparse/i,
  );
});
