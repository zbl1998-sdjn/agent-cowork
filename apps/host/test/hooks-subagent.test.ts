import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createHookEngine } from '../src/runtime/hooks.js';
import { runAgentChat, buildAgentToolset } from '../src/kimi/agent-runner.js';
import type { AgentDeps } from '../src/kimi/agent/toolset-builder.js';
import type { AgentTool, HookEngine as AgentHookEngine } from '../src/kimi/agent/approval-gate.js';
import type { HookEngine, HookResult } from '../src/runtime/hooks.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-hk-')); }

const blockedStepSchema = z.object({
  tool: z.literal('Danger'),
  blocked: z.unknown().optional(),
}).loose();
const agentResultSchema = z.object({
  text: z.string(),
}).loose();
const parallelResultSchema = z.object({
  ok: z.boolean(),
  children: z.array(z.object({ text: z.string() }).loose()),
  summary: z.string(),
}).loose();
const childEventSchema = z.object({
  type: z.string(),
  payload: z.object({
    goal: z.string().optional(),
    status: z.string().optional(),
  }).loose(),
}).loose();
type ChildEvent = z.output<typeof childEventSchema>;

function asAgentHookEngine(engine: HookEngine): AgentHookEngine {
  return {
    run: (event, payload) => engine.run(event, payload),
    blocked: (result) => {
      const blocked = engine.blocked(Array.isArray(result) ? result as HookResult[] : []);
      return blocked ? (blocked.reason ? { reason: blocked.reason } : {}) : false;
    },
  };
}

function toolByName(tools: readonly AgentTool[], name: string): AgentTool & { handler: NonNullable<AgentTool['handler']> } {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} tool present`);
  assert.equal(typeof tool.handler, 'function', `${name} handler present`);
  return tool as AgentTool & { handler: NonNullable<AgentTool['handler']> };
}

function itemAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  assert.ok(item, `${label} present`);
  return item;
}

test('hook engine: pre_tool hook can block by tool match', async () => {
  const engine = createHookEngine({ hooks: [
    { event: 'pre_tool', tool: 'Shell', handler: async () => ({ block: true, reason: 'no shell' }) },
    { event: 'post_tool', tool: '*', handler: async () => ({ ok: true }) },
  ] });
  const blocked = engine.blocked(await engine.run('pre_tool', { name: 'Shell' }));
  assert.ok(blocked && blocked.block);
  assert.equal(engine.blocked(await engine.run('pre_tool', { name: 'Write' })), null);
});

test('runAgentChat: a pre_tool hook blocks the tool (not executed)', async () => {
  const root = tmp();
  let ran = false;
  const tools = [{ name: 'Danger', risk: 'low', description: '', parameters: { type: 'object', properties: {} }, handler: async () => { ran = true; return { ok: true }; } }];
  let n = 0;
  const modelCall: ModelCall = async () => { n += 1; return n === 1 ? { content: '', tool_calls: [{ id: 'c1', function: { name: 'Danger', arguments: '{}' } }] } : { content: '完成。' }; };
  const hooks = createHookEngine({ hooks: [{ event: 'pre_tool', tool: 'Danger', handler: async () => ({ block: true, reason: '策略禁止' }) }] });
  const out = await runAgentChat({ prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, runStoreRoot: path.join(root, 'runs'), tools, modelCall, hooks: asAgentHookEngine(hooks) });
  assert.equal(ran, false, 'blocked tool must not run');
  assert.ok(out.steps.some((step) => {
    const parsed = blockedStepSchema.safeParse(step);
    return parsed.success && Boolean(parsed.data.blocked);
  }));
});

test('Agent tool spawns a nested sub-agent and returns its result', async () => {
  const root = tmp();
  // sub-agent model: always returns a final answer (no tool calls)
  const subModel: ModelCall = async () => ({ content: '子任务完成' });
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: {} },
    agentDeps: { kimiConfig: { model: 'fake' }, modelCall: subModel, approvals: null, autoApprove: true, hooks: null, emit: () => undefined },
    runDeps: { runStoreRoot: path.join(root, 'runs') },
  });
  const agentTool = toolByName(tools, 'Agent');
  const res = agentResultSchema.parse(await agentTool.handler({ task: '整理一下' }));
  assert.equal(res.text, '子任务完成');
});

test('AgentParallel tool dispatches nested sub-agents concurrently and summarizes results', async () => {
  const root = tmp();
  let active = 0;
  let maxActive = 0;
  const runNestedAgentChat: NonNullable<AgentDeps['runAgentChat']> = async ({ prompt }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 80));
    active -= 1;
    return { text: `完成:${prompt}`, steps: [{ tool: 'none' }] };
  };
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: {} },
    agentDeps: { kimiConfig: { model: 'fake' }, modelCall: async () => ({}), runAgentChat: runNestedAgentChat, approvals: null, autoApprove: true, hooks: null, emit: () => undefined },
    runDeps: { runStoreRoot: path.join(root, 'runs') },
  });
  const parallelTool = toolByName(tools, 'AgentParallel');

  const res = parallelResultSchema.parse(await parallelTool.handler({ tasks: ['审查 A', '审查 B', '审查 C'], maxConcurrency: 3 }));

  assert.equal(res.ok, true);
  assert.equal(res.children.length, 3);
  assert.ok(maxActive > 1, `expected concurrent child agents, saw maxActive=${maxActive}`);
  assert.deepEqual(res.children.map((child) => child.text), ['完成:审查 A', '完成:审查 B', '完成:审查 C']);
  assert.match(res.summary, /审查 A/);
});

test('AgentParallel emits child lifecycle events for UI grouping', async () => {
  const root = tmp();
  const events: ChildEvent[] = [];
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 'tenant_ui' } },
    agentDeps: {
      emit: (type, payload) => { events.push(childEventSchema.parse({ type, payload })); },
      runAgentChat: async ({ prompt }) => ({ text: `完成:${prompt}`, steps: [] }),
    },
    runDeps: { runStoreRoot: path.join(root, 'runs') },
  });
  const parallelTool = toolByName(tools, 'AgentParallel');
  await parallelTool.handler({ tasks: ['审查 A', '审查 B'], maxConcurrency: 2 });

  assert.deepEqual(events.map((event) => event.type), [
    'child_start',
    'child_start',
    'child_end',
    'child_end',
  ]);
  assert.equal(itemAt(events, 0, 'first child event').payload.goal, '审查 A');
  assert.equal(itemAt(events, 3, 'last child event').payload.status, 'succeeded');
});
