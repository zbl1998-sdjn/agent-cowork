import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAgentToolset } from '../src/engine/agent-runner.js';
import { createParallelSubAgentTool } from '../src/engine/agent/parallel-agent-tool.js';
import type {
  AgentDeps,
  AgentTool,
  SkillRegistry,
  ToolRegistry,
  ToolsetContext,
} from '../src/engine/agent/toolset-builder.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-toolset-'));
}

function contextFor(root: string): ToolsetContext {
  return {
    trustedRoot: root,
    context: { tenantId: 'tenant-a', userId: 'user-a', traceId: 'trace-a' },
    sandbox: { kind: 'test-sandbox' },
    sandboxLimits: { timeoutMs: 1000 },
  };
}

function toolNamed(tools: AgentTool[], name: string): AgentTool & { handler: NonNullable<AgentTool['handler']> } {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool?.handler, `expected tool ${name} to be present`);
  return tool as AgentTool & { handler: NonNullable<AgentTool['handler']> };
}

function toolNames(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'tools should be an array');
  return value
    .map((tool) => tool && typeof tool === 'object' ? String((tool as { name?: unknown }).name || '') : '')
    .filter(Boolean);
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value.map((item, index) => {
    assert.ok(item && typeof item === 'object' && !Array.isArray(item), `${label}[${index}] should be an object`);
    return item as Record<string, unknown>;
  });
}

test('buildAgentToolset exposes only valid MCP descriptors and forwards trusted context', async () => {
  const root = tmp();
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const calls: Array<{ name: string; args: unknown; context: Record<string, unknown> }> = [];
  const toolRegistry: ToolRegistry = {
    list: () => [
      null,
      42,
      { source: 'local', name: 'local__skip' },
      { source: 'mcp:fs', name: '   ' },
      { source: 'mcp:fs', name: 'mcp__fs__read', description: 'Read from fs MCP', inputSchema: schema },
      { source: 'mcp:calendar', name: 'mcp__calendar__list' },
    ],
    call: async (name, args, context) => {
      calls.push({ name, args, context });
      return { ok: true, name, args };
    },
  };

  const ctx = contextFor(root);
  const tools = buildAgentToolset({ ctx, toolRegistry });
  assert.equal(tools.some((tool) => tool.name === 'local__skip'), false);
  assert.equal(tools.some((tool) => tool.name === 'mcp__fs__read'), true);
  assert.equal(tools.some((tool) => tool.name === 'mcp__calendar__list'), true);

  const read = toolNamed(tools, 'mcp__fs__read');
  assert.equal(read.risk, 'high');
  assert.equal(read.mutating, true);
  assert.deepEqual(read.parameters, schema);
  const readResult = await read.handler({ path: 'README.md' });
  assert.deepEqual(readResult, { ok: true, name: 'mcp__fs__read', args: { path: 'README.md' } });

  const fallback = toolNamed(tools, 'mcp__calendar__list');
  assert.equal(fallback.description, '外部连接器工具 mcp__calendar__list');
  assert.deepEqual(fallback.parameters, { type: 'object', properties: {} });
  assert.deepEqual(calls, [
    {
      name: 'mcp__fs__read',
      args: { path: 'README.md' },
      context: { trustedRoot: root, context: ctx.context },
    },
  ]);
});

test('Skill tool rejects unavailable skills and runs an enabled recipe through runRecipe', async () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.runs');
  const skillRegistry: SkillRegistry = {
    get: (id) => {
      if (id === 'email-draft') return { enabled: true };
      if (id === 'disabled-skill') return { enabled: false };
      return null;
    },
  };
  const skill = toolNamed(buildAgentToolset({
    ctx: contextFor(root),
    skillRegistry,
    runDeps: { runStoreRoot },
  }), 'Skill');

  assert.deepEqual(await skill.handler({ id: 'missing-skill' }), { error: 'skill not available: missing-skill' });
  assert.deepEqual(await skill.handler({ id: 'disabled-skill' }), { error: 'skill not available: disabled-skill' });

  const result = await skill.handler({ id: 'email-draft', prompt: '给客户写一封项目进展跟进邮件' });
  assert.ok(result && typeof result === 'object', 'skill result should be an object');
  const record = result as { skill?: unknown; operations?: unknown; runId?: unknown };
  assert.equal(record.skill, 'email-draft');
  assert.equal(record.operations, 2);
  assert.match(String(record.runId), /^run_/);
  assert.ok(fs.existsSync(path.join(runStoreRoot, `${record.runId}.json`)), 'enabled skill writes a real run record');
});

test('interactive and child-agent tools forward context and handle unavailable dependencies', async () => {
  const root = tmp();
  const ctx = contextFor(root);
  const runStoreRoot = path.join(root, '.runs');
  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const approvalRequests: Record<string, unknown>[] = [];
  const scheduleRequests: Record<string, unknown>[] = [];
  const childRuns: Record<string, unknown>[] = [];
  let schedulerThrows = false;
  const runEvents = { publish: (runId: string, event: Record<string, unknown>) => ({ runId, ...event }) };
  const runsIndex = { upsert: (record: unknown, context: unknown) => ({ record, context }) };
  const modelCall = async () => ({ content: 'unused' });
  const agentDeps: AgentDeps = {
    approvals: {
      request: (payload) => {
        approvalRequests.push(payload);
        return { id: `approval_${approvalRequests.length}`, promise: Promise.resolve(321) };
      },
    },
    scheduler: {
      create: (args) => {
        scheduleRequests.push(args);
        if (schedulerThrows) throw new Error('scheduler down');
        return { id: 'sched_1', name: args.name, kind: args.cron ? 'cron' : 'one-shot', nextFireAt: '2026-06-20T09:00:00.000Z' };
      },
    },
    emit: (type, payload) => { emitted.push({ type, payload }); },
    runId: 'run_parent',
    runAgentChat: async (args) => {
      childRuns.push(args);
      return { text: 'child finished', steps: [{}, {}, {}] };
    },
    modelConfig: { provider: 'test' },
    modelCall,
    autoApprove: true,
    planMode: true,
    auditBus: { publish: () => undefined },
    hooks: { name: 'hooks-placeholder' },
  };

  const tools = buildAgentToolset({
    ctx,
    skillRegistry: { get: (id) => id === 'email-draft' ? { enabled: true } : null },
    agentDeps,
    runDeps: { runStoreRoot, runEvents, runsIndex },
  });
  assert.equal(tools.some((tool) => tool.name === 'AskUserQuestion'), true);
  assert.equal(tools.some((tool) => tool.name === 'ScheduleTask'), true);
  assert.equal(tools.some((tool) => tool.name === 'Agent'), true);
  assert.equal(tools.some((tool) => tool.name === 'AgentParallel'), true);

  const ask = toolNamed(tools, 'AskUserQuestion');
  assert.deepEqual(await ask.handler({ question: '   ' }), { error: 'question is required' });
  assert.deepEqual(await ask.handler({
    question: '选择哪个方案?',
    options: ['方案A', { label: '方案B', description: '保留兼容层' }, '', { label: '' }, '方案C', '方案D', '方案E', '方案F', '方案G'],
  }), { answer: '321' });
  assert.equal(approvalRequests.length, 1);
  assert.deepEqual(approvalRequests[0], {
    kind: 'question',
    question: '选择哪个方案?',
    options: [
      { label: '方案A' },
      { label: '方案B', description: '保留兼容层' },
      { label: '方案C' },
      { label: '方案D' },
      { label: '方案E' },
      { label: '方案F' },
    ],
    runId: 'run_parent',
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  assert.deepEqual(emitted[0], {
    type: 'question',
    payload: {
      id: 'approval_1',
      question: '选择哪个方案?',
      options: [
        { label: '方案A' },
        { label: '方案B', description: '保留兼容层' },
        { label: '方案C' },
        { label: '方案D' },
        { label: '方案E' },
        { label: '方案F' },
      ],
    },
  });

  const schedule = toolNamed(tools, 'ScheduleTask');
  assert.deepEqual((schedule.parameters as { required?: string[] }).required, ['name', 'recipeId']);
  assert.deepEqual(await schedule.handler({
    name: '无动作任务',
    cron: '0 9 * * *',
    prompt: '总结昨天进展',
  }), {
    error: 'recipeId is required for scheduled tasks',
    code: 'SCHEDULE_ACTION_REQUIRED',
  });
  assert.deepEqual(await schedule.handler({
    name: '每日简报',
    cron: '0 9 * * *',
    prompt: '总结昨天进展',
    recipeId: 'email-draft',
  }), {
    id: 'sched_1',
    name: '每日简报',
    kind: 'cron',
    nextFireAt: '2026-06-20T09:00:00.000Z',
    cronHuman: null,
  });
  assert.deepEqual(scheduleRequests[0], {
    name: '每日简报',
    cron: '0 9 * * *',
    fireAt: null,
    payload: { prompt: '总结昨天进展', recipeId: 'email-draft', trustedRoot: root },
    tenantId: 'tenant-a',
    userId: 'user-a',
    traceId: 'trace-a',
  });
  schedulerThrows = true;
  assert.deepEqual(await schedule.handler({ name: '坏任务', recipeId: 'email-draft' }), { error: 'scheduler down' });

  const agent = toolNamed(tools, 'Agent');
  assert.deepEqual(await agent.handler({ task: '审查 README' }), { text: 'child finished', steps: 3 });
  assert.equal(childRuns.length, 1);
  assert.equal(childRuns[0]?.prompt, '审查 README');
  assert.equal(childRuns[0]?.trustedRoot, root);
  assert.equal(childRuns[0]?.modelConfig, agentDeps.modelConfig);
  assert.equal(childRuns[0]?.modelCall, modelCall);
  assert.equal(childRuns[0]?.approvals, agentDeps.approvals);
  assert.equal(childRuns[0]?.autoApprove, true);
  assert.equal(childRuns[0]?.planMode, true);
  assert.equal(childRuns[0]?.auditBus, agentDeps.auditBus);
  assert.equal(childRuns[0]?.hooks, agentDeps.hooks);
  assert.equal(childRuns[0]?.emit, agentDeps.emit);
  assert.equal(childRuns[0]?.sandbox, ctx.sandbox);
  assert.equal(childRuns[0]?.sandboxLimits, ctx.sandboxLimits);
  assert.equal(childRuns[0]?.runStoreRoot, runStoreRoot);
  assert.equal(childRuns[0]?.runEvents, runEvents);
  assert.equal(childRuns[0]?.runsIndex, runsIndex);
  assert.deepEqual(childRuns[0]?.context, ctx.context);
  assert.equal(toolNames(childRuns[0]?.tools).includes('Agent'), false);
  assert.equal(toolNames(childRuns[0]?.tools).includes('AgentParallel'), false);
});

test('AgentParallel validates setup, task limits, and context budgets before spawning children', async () => {
  const root = tmp();
  const unavailable = createParallelSubAgentTool({
    ctx: contextFor(root),
    runDeps: {},
    agentDeps: {},
    baseTools: [],
  });
  if (typeof unavailable.handler !== 'function') throw new Error('AgentParallel handler should be present');
  const unavailableHandler = unavailable.handler;
  assert.deepEqual(await unavailableHandler({ tasks: ['x'] }), { error: 'sub-agent runner unavailable' });

  let spawned = false;
  const tool = createParallelSubAgentTool({
    ctx: contextFor(root),
    runDeps: {},
    agentDeps: {
      runAgentChat: async () => {
        spawned = true;
        return { text: 'should not run', steps: [] };
      },
    },
    baseTools: [],
  });
  if (typeof tool.handler !== 'function') throw new Error('AgentParallel handler should be present');
  const handler = tool.handler;

  assert.deepEqual(await handler({ tasks: [] }), { error: 'tasks must be a non-empty array' });
  assert.deepEqual(
    await handler({ tasks: ['a', 'b'], maxTasks: 1 }),
    { error: 'too many parallel sub-agent tasks; max 1' },
  );
  const budgetFailure = await handler({ tasks: ['a'.repeat(64)], contextBudgetBytes: 8 });
  assert.ok(budgetFailure && typeof budgetFailure === 'object', 'budget failure should be an object');
  assert.match(String((budgetFailure as { error?: unknown }).error), /context budget exceeded/);
  assert.equal(spawned, false);
});

test('AgentParallel normalizes agents aliases, records child failures, and forwards child context', async () => {
  const root = tmp();
  const baseTools = [{ name: 'Read', parameters: { type: 'object', properties: {} } }];
  const childRuns: Record<string, unknown>[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const tool = createParallelSubAgentTool({
    ctx: contextFor(root),
    runDeps: { runStoreRoot: path.join(root, '.runs'), runEvents: { publish: () => undefined }, runsIndex: { upsert: () => undefined } },
    agentDeps: {
      modelConfig: { provider: 'test-provider' },
      modelCall: async () => ({ content: 'unused' }),
      approvals: { request: () => ({ id: 'approval_1', promise: Promise.resolve(true) }) },
      autoApprove: true,
      planMode: true,
      auditBus: { publish: () => undefined },
      hooks: { run: async () => [], blocked: () => false },
      emit: (type, payload) => { events.push({ type, payload }); },
      runAgentChat: async (args) => {
        childRuns.push(args);
        if (String(args.prompt).includes('fail')) throw 'child boom';
        return { text: `ok:${args.prompt}`, steps: [{ tool: 'Read' }, { tool: 'Glob' }] };
      },
    },
    baseTools,
  });
  if (typeof tool.handler !== 'function') throw new Error('AgentParallel handler should be present');
  const handler = tool.handler;

  const result = await handler({
    agents: [
      { goal: ' inspect project A ' },
      { task: 'fail project B' },
      ' inspect project C ',
      { task: '   ' },
    ],
    maxConcurrency: 99,
    maxSteps: '2',
  });
  const record = result as Record<string, unknown>;
  const children = recordArray(record.children, 'parallel children');
  const limits = record.limits as Record<string, unknown>;

  assert.equal(record.ok, false);
  assert.equal(children.length, 3);
  assert.deepEqual(children.map((child) => child.task), ['inspect project A', 'fail project B', 'inspect project C']);
  assert.deepEqual(children.map((child) => child.ok), [true, false, true]);
  assert.equal(children[0]?.text, 'ok:inspect project A');
  assert.equal(children[0]?.steps, 2);
  assert.equal(children[1]?.error, 'child boom');
  assert.equal(limits.maxConcurrency, 3);
  assert.equal(childRuns.length, 3);
  assert.deepEqual(childRuns.map((run) => (run.context as Record<string, unknown>)?.childIndex), [0, 1, 2]);
  assert.deepEqual(toolNames(childRuns[0]?.tools), ['Read']);
  assert.equal(childRuns[0]?.maxSteps, 2);
  assert.deepEqual(childRuns.map((run) => run.planMode), [true, true, true]);
  assert.equal(childRuns[0]?.trustedRoot, root);
  assert.match(String(record.summary), /2\. fail project B: child boom/);
  assert.equal(events.filter((event) => event.type === 'child_start').length, 3);
  assert.deepEqual(events.filter((event) => event.type === 'child_end').map((event) => event.payload.status), [
    'succeeded',
    'failed',
    'succeeded',
  ]);
});

test('LoadSkill tool is mounted only with a reader and returns pack content or a safe error', async () => {
  const root = tmp();
  const withoutReader = buildAgentToolset({ ctx: contextFor(root) });
  assert.ok(!toolNames(withoutReader).includes('LoadSkill'), 'no reader -> no LoadSkill tool');

  const reader = {
    list: () => [{ name: 'pdf-processing', description: '处理 PDF。' }],
    read: (name: string, file?: string) => {
      if (name !== 'pdf-processing') throw new Error(`技能包不存在: ${name}`);
      return { name, file: file || 'SKILL.md', content: '# 步骤\n先读文件。' };
    },
  };
  const tools = buildAgentToolset({ ctx: contextFor(root), skillPackReader: reader });
  const loadSkill = toolNamed(tools, 'LoadSkill');
  assert.equal(loadSkill.risk, 'safe');
  assert.equal(loadSkill.mutating, false);

  const ok = await loadSkill.handler({ name: 'pdf-processing' });
  assert.deepEqual(ok, { name: 'pdf-processing', file: 'SKILL.md', content: '# 步骤\n先读文件。' });
  const missing = await loadSkill.handler({ name: 'no-such-pack' });
  assert.deepEqual(missing, { error: '技能包不存在: no-such-pack' });
});
