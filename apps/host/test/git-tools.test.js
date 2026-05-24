import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';
import { createGitDiffTool, createGitLogTool, createGitStatusTool } from '../src/tools/dev/git.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-git-'));
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function repo() {
  const root = tmp();
  git(root, ['init']);
  git(root, ['config', 'user.email', 'agent@example.test']);
  git(root, ['config', 'user.name', 'Agent Test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n', 'utf8');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

test('git read-only tools are jailed and expose status/diff/log output', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n', 'utf8');

  const status = await createGitStatusTool().handler({}, { trustedRoot: root });
  assert.equal(status.ok, true);
  assert.match(status.stdout, /M a\.txt/);

  const diff = await createGitDiffTool().handler({ path: 'a.txt', context: 1 }, { trustedRoot: root });
  assert.equal(diff.ok, true);
  assert.match(diff.stdout, /\+two/);

  const log = await createGitLogTool().handler({ maxCount: 1 }, { trustedRoot: root });
  assert.equal(log.ok, true);
  assert.match(log.stdout, /init/);

  await assert.rejects(
    () => createGitDiffTool().handler({ path: '../outside.txt' }, { trustedRoot: root }),
    /escaped|outside|Sensitive/i,
  );
});

test('read-only git tools are discoverable as builtin and agent tools', () => {
  const builtinNames = createBuiltinTools({ sandbox: null }).map((tool) => tool.name);
  assert.ok(builtinNames.includes('git.status'));
  assert.ok(builtinNames.includes('git.diff'));
  assert.ok(builtinNames.includes('git.log'));

  const agentNames = createAgentTools({ trustedRoot: tmp() }).map((tool) => tool.name);
  assert.ok(agentNames.includes('GitStatus'));
  assert.ok(agentNames.includes('GitDiff'));
  assert.ok(agentNames.includes('GitLog'));
});

test('GitCommit is high-risk and goes through approval before mutating', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'b.txt'), 'two\n', 'utf8');
  const approvals = createApprovalRegistry();
  const events = [];
  let calls = 0;
  const modelCall = async ({ tools }) => {
    calls += 1;
    if (calls === 1 && tools && tools.length) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'GitCommit', arguments: JSON.stringify({ message: 'add b', paths: ['b.txt'] }) } }] };
    }
    return { content: 'done' };
  };
  const emit = (type, payload) => {
    events.push({ type, payload });
    if (type === 'approval_request') approvals.resolve(payload.id, 'reject');
  };

  const out = await runAgentChat({
    prompt: 'commit b.txt',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    modelCall,
    approvals,
    emit,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.ok(events.some((event) => event.type === 'approval_request' && event.payload.name === 'GitCommit' && event.payload.risk === 'high'));
  assert.ok(out.steps.some((step) => step.tool === 'GitCommit' && step.rejected));
  assert.match(git(root, ['status', '--porcelain=v1']), /\?\? b\.txt/);
});
