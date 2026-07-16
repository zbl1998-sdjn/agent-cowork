import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceApprovalRules, listWorkspaceApprovalRules, removeWorkspaceApprovalRule } from '../src/runtime/approval-rules.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acw-apprule-'));
}

test('workspace approval rules persist across instances and stay scoped per workspace', () => {
  const rootA = makeRoot();
  const rootB = makeRoot();
  const rulesA = createWorkspaceApprovalRules(rootA);
  assert.equal(rulesA.has('Write'), false);

  rulesA.add('Write');
  rulesA.add('mcp__fs__read_text');
  assert.equal(rulesA.has('Write'), true);
  assert.deepEqual(rulesA.list(), ['Write', 'mcp__fs__read_text']);

  const reloaded = createWorkspaceApprovalRules(rootA);
  assert.equal(reloaded.has('Write'), true, 'rules survive a new run/snapshot');
  assert.equal(createWorkspaceApprovalRules(rootB).has('Write'), false, 'rules never leak across workspaces');
  assert.match(
    fs.readFileSync(path.join(rootA, '.AgentCowork', 'settings', 'approval-rules.json'), 'utf8'),
    /alwaysAllow/,
  );
});

test('invalid tool names are ignored on add and dropped on read', () => {
  const root = makeRoot();
  const rules = createWorkspaceApprovalRules(root);
  rules.add('../escape');
  rules.add('');
  assert.deepEqual(rules.list(), []);

  const file = path.join(root, '.AgentCowork', 'settings', 'approval-rules.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ alwaysAllow: ['Write', '../x', 42] }));
  assert.deepEqual(createWorkspaceApprovalRules(root).list(), ['Write']);

  fs.writeFileSync(file, '坏 JSON');
  assert.deepEqual(createWorkspaceApprovalRules(root).list(), [], 'corrupt file degrades to empty');
});

test('list and remove expose and revoke persisted rules idempotently', () => {
  const root = makeRoot();
  const rules = createWorkspaceApprovalRules(root);
  rules.add('Write');
  rules.add('Edit');
  assert.deepEqual(listWorkspaceApprovalRules(root), ['Edit', 'Write']);

  assert.deepEqual(removeWorkspaceApprovalRule(root, 'Edit'), ['Write']);
  assert.deepEqual(removeWorkspaceApprovalRule(root, 'Edit'), ['Write'], 'removing twice is a no-op');
  assert.deepEqual(listWorkspaceApprovalRules(root), ['Write']);
  assert.equal(createWorkspaceApprovalRules(root).has('Edit'), false, 'revoked rule no longer auto-approves');
});
