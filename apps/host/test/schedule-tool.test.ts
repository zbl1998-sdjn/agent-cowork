import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAgentToolset, runAgentChat } from '../src/engine/agent-runner.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sched-')); }

type CreatedSchedule = {
  name?: unknown;
  cron?: unknown;
  tenantId?: unknown;
  payload?: {
    prompt?: unknown;
    recipeId?: unknown;
    trustedRoot?: unknown;
  };
};

const ENABLED_RECIPE_REGISTRY = {
  get: (id: unknown) => id === 'meeting-actions' ? { enabled: true } : null,
};

test('ScheduleTask is high-risk, mutating, and creates only after an explicit approval', async () => {
  const root = tmp();
  const created: { value: CreatedSchedule | null } = { value: null };
  const scheduler = {
    create: (rec: Record<string, unknown>) => {
      created.value = rec as CreatedSchedule;
      return { id: 'sched_1', name: rec.name, kind: rec.cron ? 'cron' : 'one-shot', nextFireAt: '2026-05-24T06:00:00Z', cronHuman: '每天 06:00' };
    },
  };
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 't1', userId: 'u1', traceId: 'tr1' } },
    skillRegistry: ENABLED_RECIPE_REGISTRY,
    agentDeps: { modelConfig: TEST_LOCAL_MODEL_CONFIG, modelCall: async () => ({}), scheduler },
  });
  const scheduleTool = tools.find((tool) => tool.name === 'ScheduleTask');
  assert.ok(scheduleTool, 'ScheduleTask exposed when a scheduler is present');
  assert.equal(scheduleTool.risk, 'high');
  assert.equal(scheduleTool.mutating, true);
  assert.equal(scheduleTool.requiresApproval, true);

  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ScheduleTask', arguments: JSON.stringify({ name: '每日简报', cron: '0 6 * * *', prompt: '整理昨天的会议记录', recipeId: 'meeting-actions' }) } }] };
    return { content: '已为你创建定时任务「每日简报」。' };
  };
  const approvalRequests: Record<string, unknown>[] = [];
  const out = await runAgentChat({
    prompt: '每天早上 6 点总结邮件',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    runStoreRoot: path.join(root, 'runs'),
    approvals: {
      request: (payload) => {
        approvalRequests.push(payload);
        return { id: 'apr_schedule', promise: Promise.resolve('once') };
      },
    },
  });

  const schedule = created.value;
  assert.ok(schedule, 'scheduler.create was called');
  assert.equal(schedule.name, '每日简报');
  assert.equal(schedule.cron, '0 6 * * *');
  assert.equal(schedule.tenantId, 't1');
  assert.ok(schedule.payload);
  assert.equal(schedule.payload.prompt, '整理昨天的会议记录');
  assert.equal(schedule.payload.recipeId, 'meeting-actions');
  assert.equal(schedule.payload.trustedRoot, root);
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0]?.name, 'ScheduleTask');
  assert.equal(out.text, '已为你创建定时任务「每日简报」。');
});

test('ScheduleTask rejects prompt-only, unknown, and disabled recipes before scheduler.create', async () => {
  const root = tmp();
  let createCalls = 0;
  const scheduleTool = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 't1', userId: 'u1' } },
    skillRegistry: {
      get: (id) => id === 'disabled-recipe' ? { enabled: false } : null,
    },
    agentDeps: {
      scheduler: {
        create: () => {
          createCalls += 1;
          return { id: 'should-not-exist', name: 'invalid', kind: 'cron' };
        },
      },
    },
  }).find((tool) => tool.name === 'ScheduleTask');
  assert.ok(scheduleTool?.handler);
  const required = (scheduleTool.parameters as { required?: string[] }).required || [];
  assert.deepEqual(required, ['name', 'recipeId']);

  assert.deepEqual(
    await scheduleTool.handler({ name: 'prompt only', cron: '0 6 * * *', prompt: '总结邮件' }),
    { error: 'recipeId is required for scheduled tasks', code: 'SCHEDULE_ACTION_REQUIRED' },
  );
  assert.deepEqual(
    await scheduleTool.handler({ name: 'missing', cron: '0 6 * * *', recipeId: 'missing-recipe' }),
    { error: 'scheduled recipe is not available: missing-recipe', code: 'RECIPE_UNAVAILABLE' },
  );
  assert.deepEqual(
    await scheduleTool.handler({ name: 'disabled', cron: '0 6 * * *', recipeId: 'disabled-recipe' }),
    { error: 'scheduled recipe is not available: disabled-recipe', code: 'RECIPE_UNAVAILABLE' },
  );
  assert.equal(createCalls, 0);
});

test('ScheduleTask fails closed when no approval registry is available', async () => {
  const root = tmp();
  let createCalls = 0;
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 't1', userId: 'u1' } },
    skillRegistry: { get: () => ({ enabled: true }) },
    agentDeps: {
      modelConfig: TEST_LOCAL_MODEL_CONFIG,
      modelCall: async () => ({}),
      scheduler: {
        create: () => {
          createCalls += 1;
          return { id: 'sched_forbidden', name: 'forbidden', kind: 'cron' };
        },
      },
    },
  });
  let modelCalls = 0;
  const out = await runAgentChat({
    prompt: '创建周期任务',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall: async () => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ScheduleTask', arguments: JSON.stringify({ name: '每日任务', cron: '0 6 * * *', recipeId: 'daily' }) } }] };
      }
      return { content: '未创建任务。' };
    },
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(createCalls, 0);
  assert.equal(out.steps.some((step) => step.tool === 'ScheduleTask' && step.approvalUnavailable === true), true);
});

test('no ScheduleTask tool when no scheduler is provided', () => {
  const tools = buildAgentToolset({
    ctx: { trustedRoot: '/tmp', context: {} },
    agentDeps: { modelConfig: TEST_LOCAL_MODEL_CONFIG, modelCall: async () => ({}) },
  });
  assert.ok(!tools.some((t) => t.name === 'ScheduleTask'));
});
