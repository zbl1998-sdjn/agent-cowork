import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { planFileOrganization } from '../src/workspace/file-organizer.js';
import { makeTestWorkspace } from './test-fixtures.js';

function root() {
  return makeTestWorkspace('kcw-organize');
}

test('plans extension-based file organization without applying it', () => {
  const trustedRoot = root();
  fs.writeFileSync(path.join(trustedRoot, 'a.csv'), 'x\n', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, 'b.md'), '# b\n', 'utf8');

  const plan = planFileOrganization({ trustedRoot, files: ['a.csv', 'b.md'], mode: 'byExtension' });

  assert.equal(plan.operations.length, 2);
  assert.match(plan.operations[0].to, /organized[\\/]csv[\\/]a\.csv$/);
  assert.equal(fs.existsSync(path.join(trustedRoot, 'organized')), false);
  assert.equal(plan.preview.operations[0].type, 'move');
});

test('plans duplicate moves by content hash', () => {
  const trustedRoot = root();
  fs.writeFileSync(path.join(trustedRoot, 'a.txt'), 'same', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, 'b.txt'), 'same', 'utf8');
  fs.writeFileSync(path.join(trustedRoot, 'c.txt'), 'different', 'utf8');

  const plan = planFileOrganization({ trustedRoot, files: ['a.txt', 'b.txt', 'c.txt'], mode: 'dedupe' });

  assert.equal(plan.operations.length, 1);
  assert.match(plan.operations[0].to, /duplicates[\\/]b\.txt$/);
});

test('rejects organization paths outside the trusted root', () => {
  const trustedRoot = root();
  assert.throws(() => planFileOrganization({ trustedRoot, files: ['../outside.txt'] }), /outside|escaped|Sensitive/i);
});

test('organization planner is available as safe builtin and agent tool', () => {
  assert.ok(createBuiltinTools({ sandbox: null }).some((tool) => tool.name === 'file.plan-organize'));
  const tool = createAgentTools({ trustedRoot: root() }).find((item) => item.name === 'PlanFileOrganization');
  assert.equal(tool?.mutating, false);
  assert.equal(tool?.risk, 'safe');
});
