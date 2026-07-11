import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryStore } from '../src/memory/memory-store.js';
import { createUserProfile } from '../src/memory/profile.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-profile-'));
}
const owner = { tenantId: 'tenant_test', userId: 'user_test' };

test('UserProfile learns, recalls, and forgets local profile entries', async () => {
  const root = tempRoot();
  const profile = createUserProfile({
    memoryStore: createMemoryStore(),
    now: () => new Date('2026-05-24T00:00:00Z'),
  });

  await profile.learn(root, {
    type: 'term',
    key: 'FE',
    value: '前端体验验收',
    evidence: '用户确认 FE 表示前端体验验收',
  }, owner);
  await profile.learn(root, {
    type: 'project',
    key: 'current',
    value: 'Agent Cowork',
    evidence: '当前工作区',
  }, owner);

  const recalled = await profile.recall(root, { query: '请继续 FE 验收', context: owner });
  assert.equal(recalled.project, 'Agent Cowork');
  assert.ok(recalled.terms.includes('FE = 前端体验验收'));
  assert.ok(recalled.entries.every((entry) => entry.evidence));

  const result = await profile.forget(root, { type: 'term', key: 'FE' }, owner);
  assert.equal(result.removed, 1);
  const after = await profile.recall(root, { query: 'FE', context: owner });
  assert.deepEqual(after.terms, []);
});

test('UserProfile upserts matching entries instead of duplicating them', async () => {
  const root = tempRoot();
  const profile = createUserProfile({ memoryStore: createMemoryStore() });

  await profile.learn(root, { type: 'term', key: 'A4', value: '旧解释', evidence: 'first' }, owner);
  await profile.learn(root, { type: 'term', key: 'A4', value: '新解释', evidence: 'second' }, owner);

  const loaded = await profile.load(root, owner);
  assert.equal(loaded.entries.length, 1);
  const [entry] = loaded.entries;
  assert.ok(entry);
  assert.equal(entry.value, '新解释');
});
