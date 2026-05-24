import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryStore } from '../src/memory/memory-store.js';
import { createUserProfile } from '../src/memory/profile.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-profile-'));
}

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
  });
  await profile.learn(root, {
    type: 'project',
    key: 'current',
    value: 'Agent Cowork',
    evidence: '当前工作区',
  });

  const recalled = await profile.recall(root, { query: '请继续 FE 验收' });
  assert.equal(recalled.project, 'Agent Cowork');
  assert.ok(recalled.terms.includes('FE = 前端体验验收'));
  assert.ok(recalled.entries.every((entry) => entry.evidence));

  const result = await profile.forget(root, { type: 'term', key: 'FE' });
  assert.equal(result.removed, 1);
  const after = await profile.recall(root, { query: 'FE' });
  assert.deepEqual(after.terms, []);
});

test('UserProfile upserts matching entries instead of duplicating them', async () => {
  const root = tempRoot();
  const profile = createUserProfile({ memoryStore: createMemoryStore() });

  await profile.learn(root, { type: 'term', key: 'A4', value: '旧解释', evidence: 'first' });
  await profile.learn(root, { type: 'term', key: 'A4', value: '新解释', evidence: 'second' });

  const loaded = await profile.load(root);
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].value, '新解释');
});
