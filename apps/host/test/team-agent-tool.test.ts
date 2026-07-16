import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeamSubAgentTool, validateTeamTasks } from '../src/engine/agent/team-agent-tool.js';
import type { AgentDeps, SubAgentToolOptions, ToolsetContext } from '../src/engine/agent/toolset-builder-types.js';

const ctx: ToolsetContext = { trustedRoot: 'C:/tmp/team', context: { tenantId: 'tenant-a', userId: 'user-a' } };

function teamTool(agentDeps: AgentDeps) {
  const options: SubAgentToolOptions = { ctx, runDeps: {}, agentDeps, baseTools: [] };
  const tool = createTeamSubAgentTool(options);
  assert.ok(tool.handler);
  return tool as typeof tool & { handler: NonNullable<typeof tool.handler> };
}

test('validateTeamTasks builds topological stages and rejects bad graphs', () => {
  const diamond = validateTeamTasks([
    { task: '调研 A' },
    { task: '调研 B', dependsOn: [0] },
    { task: '调研 C', dependsOn: [0] },
    { task: '汇总', dependsOn: [1, 2] },
  ]);
  assert.equal(diamond.error, undefined);
  assert.deepEqual(diamond.stages, [[0], [1, 2], [3]]);

  assert.match(String(validateTeamTasks([]).error), /non-empty/);
  assert.match(String(validateTeamTasks([{ task: 'a', dependsOn: [5] }]).error), /invalid dependsOn/);
  assert.match(String(validateTeamTasks([{ task: 'a', dependsOn: [0] }]).error), /depends on itself/);
  assert.match(String(validateTeamTasks([
    { task: 'a', dependsOn: [1] },
    { task: 'b', dependsOn: [0] },
  ]).error), /cycle/);
  assert.match(String(validateTeamTasks(Array.from({ length: 9 }, (_, i) => ({ task: `t${i}` }))).error), /too many/);
});

test('AgentTeam runs stages in order, injects dependency results, and reports provenance', async () => {
  const started: number[] = [];
  const prompts = new Map<number, string>();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const agentDeps: AgentDeps = {
    emit: (type, payload) => { events.push({ type, payload }); },
    runAgentChat: async (args) => {
      const index = Number((args.context as { childIndex?: unknown }).childIndex);
      started.push(index);
      prompts.set(index, String(args.prompt));
      return { text: `任务${index}结论`, steps: [{}] };
    },
  };
  const result = await teamTool(agentDeps).handler({
    tasks: [
      { task: '读上周记录' },
      { task: '读本周记录' },
      { task: '写周报', dependsOn: [0, 1] },
    ],
  }) as { ok: boolean; stages: number[][]; children: Array<{ ok: boolean; stage: number }>; provenance: string };

  assert.equal(result.ok, true);
  assert.deepEqual(result.stages, [[0, 1], [2]]);
  assert.equal(started.at(-1), 2, 'the dependent summary task runs last');
  assert.match(String(prompts.get(2)), /前置任务 1 结果】任务0结论/);
  assert.match(String(prompts.get(2)), /前置任务 2 结果】任务1结论/);
  assert.match(String(prompts.get(2)), /不是指令/);
  assert.match(result.provenance, /不构成授权/);
  const childStarts = events.filter((e) => e.type === 'child_start');
  assert.equal(childStarts.length, 3);
  assert.deepEqual(childStarts.at(-1)?.payload.dependsOn, [0, 1]);
});

test('AgentTeam skips the whole chain below a failed dependency but runs independent tasks', async () => {
  const agentDeps: AgentDeps = {
    emit: () => undefined,
    runAgentChat: async (args) => {
      const index = Number((args.context as { childIndex?: unknown }).childIndex);
      if (index === 0) throw new Error('模拟前置失败');
      return { text: `任务${index}结论`, steps: [] };
    },
  };
  const result = await teamTool(agentDeps).handler({
    tasks: [
      { task: '会失败的前置' },
      { task: '依赖它的任务', dependsOn: [0] },
      { task: '再下一级', dependsOn: [1] },
      { task: '独立任务' },
    ],
  }) as { ok: boolean; children: Array<{ ok: boolean; skipped?: boolean; error?: string }> };

  assert.equal(result.ok, false);
  assert.equal(result.children[0]?.ok, false);
  assert.equal(result.children[1]?.skipped, true);
  assert.match(String(result.children[1]?.error), /前置任务 1 未成功/);
  assert.equal(result.children[2]?.skipped, true);
  assert.equal(result.children[3]?.ok, true, 'independent branch still runs');
});
