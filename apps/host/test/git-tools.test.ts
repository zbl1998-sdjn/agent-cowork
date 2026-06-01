import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createGitCommitTool, createGitDiffTool, createGitLogTool, createGitStatusTool } from '../src/tools/dev/git.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { createAgentApprovalRegistry } from './helpers/approvals.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';
import type { GitRunResult } from '../src/tools/dev/git-runner.js';
import type { EmittedEvent } from './helpers/agent.js';

const gitRunResultSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number(),
  workspace: z.string(),
  stdout: z.string(),
  stderr: z.string(),
}).passthrough();

const modelToolsArgsSchema = z.object({
  tools: z.array(z.unknown()).optional(),
}).passthrough();

const approvalRequestPayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  risk: z.string(),
}).passthrough();

const rejectedGitCommitStepSchema = z.object({
  tool: z.literal('GitCommit'),
  rejected: z.literal(true),
}).passthrough();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-git-'));
}

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }));
}

function repo(): string {
  const root = tmp();
  git(root, ['init']);
  git(root, ['config', 'user.email', 'agent@example.test']);
  git(root, ['config', 'user.name', 'Agent Test']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n', 'utf8');
  git(root, ['add', 'a.txt']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

function gitRunResult(value: unknown): GitRunResult {
  return gitRunResultSchema.parse(value) as GitRunResult;
}

function hasRejectedGitCommitStep(steps: readonly unknown[]): boolean {
  return steps.some((step) => rejectedGitCommitStepSchema.safeParse(step).success);
}

test('git read-only tools are jailed and expose status/diff/log output', async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n', 'utf8');

  const status = gitRunResult(await createGitStatusTool().handler({}, { trustedRoot: root }));
  assert.equal(status.ok, true);
  assert.match(status.stdout, /M a\.txt/);

  const diff = gitRunResult(await createGitDiffTool().handler({ path: 'a.txt', context: 1 }, { trustedRoot: root }));
  assert.equal(diff.ok, true);
  assert.match(diff.stdout, /\+two/);

  const log = gitRunResult(await createGitLogTool().handler({ maxCount: 1 }, { trustedRoot: root }));
  assert.equal(log.ok, true);
  assert.match(log.stdout, /init/);

  await assert.rejects(
    () => createGitDiffTool().handler({ path: '../outside.txt' }, { trustedRoot: root }),
    /escaped|outside|Sensitive/i,
  );
});

test('git tools reject unknown input keys before command execution', async () => {
  const root = repo();

  await assert.rejects(
    () => createGitStatusTool().handler({ raw: ['status'] }, { trustedRoot: root }),
    /git\.status: .*raw/i,
  );

  await assert.rejects(
    () => createGitCommitTool().handler({ message: 'noop', raw: ['add', '.'] }, { trustedRoot: root }),
    /GitCommit: .*raw/i,
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
  const approvals = createAgentApprovalRegistry();
  const events: EmittedEvent[] = [];
  let calls = 0;
  const modelCall: ModelCall = async (args) => {
    const { tools } = modelToolsArgsSchema.parse(args);
    calls += 1;
    if (calls === 1 && tools && tools.length) {
      return { content: '', tool_calls: [{ id: 'c1', function: { name: 'GitCommit', arguments: JSON.stringify({ message: 'add b', paths: ['b.txt'] }) } }] };
    }
    return { content: 'done' };
  };
  const emit = (type: string, payload: unknown) => {
    events.push({ type, payload });
    if (type === 'approval_request') {
      approvals.resolve(approvalRequestPayloadSchema.parse(payload).id, 'reject');
    }
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

  assert.ok(events.some((event) => {
    if (event.type !== 'approval_request') return false;
    const payload = approvalRequestPayloadSchema.safeParse(event.payload);
    return payload.success && payload.data.name === 'GitCommit' && payload.data.risk === 'high';
  }));
  assert.ok(hasRejectedGitCommitStep(out.steps));
  assert.match(git(root, ['status', '--porcelain=v1']), /\?\? b\.txt/);
});
