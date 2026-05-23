import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAgentToolset, runAgentChat } from '../src/kimi/agent-runner.js';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sched-')); }

test('ScheduleTask tool is exposed and creates a schedule via scheduler.create', async () => {
  const root = tmp();
  let created = null;
  const scheduler = {
    create: (rec) => { created = rec; return { id: 'sched_1', name: rec.name, kind: rec.cron ? 'cron' : 'one-shot', nextFireAt: '2026-05-24T06:00:00Z', cronHuman: '每天 06:00' }; },
  };
  const tools = buildAgentToolset({
    ctx: { trustedRoot: root, context: { tenantId: 't1', userId: 'u1', traceId: 'tr1' } },
    agentDeps: { kimiConfig: {}, modelCall: async () => ({}), approvals: createApprovalRegistry(), scheduler },
  });
  assert.ok(tools.some((t) => t.name === 'ScheduleTask'), 'ScheduleTask exposed when a scheduler is present');

  let n = 0;
  const modelCall = async () => {
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'ScheduleTask', arguments: JSON.stringify({ name: '每日简报', cron: '0 6 * * *', prompt: '总结昨天的邮件' }) } }] };
    return { content: '已为你创建定时任务「每日简报」。' };
  };
  const out = await runAgentChat({ prompt: '每天早上 6 点总结邮件', kimiConfig: {}, trustedRoot: root, tools, modelCall, runStoreRoot: path.join(root, 'runs') });

  assert.ok(created, 'scheduler.create was called');
  assert.equal(created.name, '每日简报');
  assert.equal(created.cron, '0 6 * * *');
  assert.equal(created.tenantId, 't1');
  assert.equal(created.payload.prompt, '总结昨天的邮件');
  assert.equal(created.payload.trustedRoot, root);
  assert.equal(out.text, '已为你创建定时任务「每日简报」。');
});

test('no ScheduleTask tool when no scheduler is provided', () => {
  const tools = buildAgentToolset({
    ctx: { trustedRoot: '/tmp', context: {} },
    agentDeps: { kimiConfig: {}, modelCall: async () => ({}), approvals: createApprovalRegistry() },
  });
  assert.ok(!tools.some((t) => t.name === 'ScheduleTask'));
});
