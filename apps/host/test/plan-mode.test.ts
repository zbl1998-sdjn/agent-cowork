import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { AuditEventBus } from '../src/runtime/audit-events.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { AgentTool } from '../src/kimi/agent-tools-types.js';
import type { AuditEvent } from '../src/storage/audit-events.js';

type ScriptedResponse = {
  content: string;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
};
type ApprovalRequestMeta = Record<string, unknown> & { kind?: unknown; name?: unknown };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-plan-')); }

// A scripted model: yields a preset list of assistant messages in order, then
// repeats the last one (a plain final answer) to end the loop.
function scriptedModel(script: ScriptedResponse[]) {
  let i = 0;
  const fallback = script.at(-1) || { content: '' };
  return async () => script[Math.min(i++, script.length - 1)] || fallback;
}
function toolCall(name: string, args: Record<string, unknown> = {}): ScriptedResponse {
  return { content: '', tool_calls: [{ id: `c_${Math.random().toString(16).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args || {}) } }] };
}

// Approvals stub that resolves each request with a queued decision and records
// what was asked, so tests can assert which tools actually hit the gate.
function queuedApprovals(decisions: string[]) {
  const q = [...decisions];
  const requested: ApprovalRequestMeta[] = [];
  return {
    requested,
    request(meta: ApprovalRequestMeta) {
      requested.push(meta);
      const decision = q.shift() ?? 'once';
      return { id: `apr_${requested.length}`, promise: Promise.resolve(decision) };
    },
  };
}

function collectAudit() {
  const events: AuditEvent[] = [];
  const bus = new AuditEventBus();
  bus.subscribe((e) => { events.push(e); });
  return { bus, events };
}

test('plan mode blocks mutating tools until ExitPlanMode is approved', async () => {
  const root = tmp();
  const { bus, events } = collectAudit();
  const approvals = queuedApprovals(['once', 'once']); // approve the plan, then the write
  const model = scriptedModel([
    toolCall('Write', { path: 'a.txt', content: 'before-plan' }), // blocked: no approved plan yet
    toolCall('ExitPlanMode', { plan: '步骤1：写 a.txt；步骤2：汇报。' }), // approved
    toolCall('Write', { path: 'a.txt', content: 'after-plan' }), // explicitly approved after the plan
    { content: '完成。' },
  ]);
  const out = await runAgentChat({
    prompt: '建 a.txt', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall: model,
    planMode: true, approvals, auditBus: bus, runStoreRoot: path.join(root, 'runs'),
  });
  // The pre-plan Write was blocked, so the file only ever gets the post-plan content.
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'after-plan');
  assert.equal(out.text, '完成。');
  await bus.flush();
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('tool.plan_blocked'), 'pre-plan write is audited as plan_blocked');
  assert.ok(kinds.includes('plan.proposed'));
  assert.ok(kinds.includes('plan.approved'));
  assert.ok(kinds.includes('tool.approved'), 'post-plan write records explicit approval');
  assert.equal(kinds.includes('tool.auto_approved'), false, 'an approved plan must not auto-approve tools');
  // The plan and the post-plan write each go through the approval registry.
  assert.equal(approvals.requested.length, 2);
  const [planApproval, writeApproval] = approvals.requested;
  assert.ok(planApproval);
  assert.equal(planApproval.kind, 'plan');
  assert.ok(writeApproval);
  assert.equal(writeApproval.kind, 'tool');
  assert.equal(writeApproval.name, 'Write');
  assert.deepEqual(writeApproval.args, { path: 'a.txt', content: 'after-plan' });
});

test('rejecting the plan keeps mutating tools blocked', async () => {
  const root = tmp();
  const approvals = queuedApprovals(['reject']); // keep planning
  const model = scriptedModel([
    toolCall('ExitPlanMode', { plan: '草案：写 b.txt' }), // rejected
    toolCall('Write', { path: 'b.txt', content: 'x' }), // still blocked (plan not approved)
    { content: '我会根据反馈继续完善计划。' },
  ]);
  const out = await runAgentChat({
    prompt: 'x', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall: model,
    planMode: true, approvals, runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false, 'rejected plan must not allow writes');
  assert.equal(out.text, '我会根据反馈继续完善计划。');
});

test('approval gate closes the leak: a plain Write requires approval (not just high-risk)', async () => {
  const root = tmp();
  const approvals = queuedApprovals(['reject']); // reject the write
  const model = scriptedModel([
    toolCall('Write', { path: 'c.txt', content: 'nope' }),
    { content: '已取消写入。' },
  ]);
  await runAgentChat({
    prompt: 'x', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall: model,
    approvals, runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false, 'a rejected Write must not happen');
  assert.equal(approvals.requested.length, 1);
  const [writeApproval] = approvals.requested;
  assert.ok(writeApproval);
  assert.equal(writeApproval.name, 'Write');
});

test('autoApprove covers non-high mutations but high-risk stays explicit', async () => {
  const root = tmp();
  let dangerRan = 0;
  const approvals = queuedApprovals(['reject']); // reject the high-risk call
  const customTools: AgentTool[] = [
    { name: 'Write', risk: 'write', mutating: true, description: 'w', parameters: { type: 'object', properties: {} }, handler: async () => { fs.writeFileSync(path.join(root, 'd.txt'), 'y'); return { ok: true }; } },
    { name: 'Danger', risk: 'high', mutating: true, description: 'd', parameters: { type: 'object', properties: {} }, handler: async () => { dangerRan += 1; return { ok: true }; } },
  ];
  const model = scriptedModel([
    toolCall('Write', {}), // non-high → autoApprove runs it without a prompt
    toolCall('Danger', {}), // high-risk → must hit the approval gate → rejected → does not run
    { content: '完成。' },
  ]);
  await runAgentChat({
    prompt: 'x', kimiConfig: TEST_LOCAL_MODEL_CONFIG, trustedRoot: root, modelCall: model,
    tools: customTools, approvals, autoApprove: true, runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(fs.existsSync(path.join(root, 'd.txt')), true, 'non-high write auto-approved under autoApprove');
  assert.equal(dangerRan, 0, 'high-risk must NOT auto-run under autoApprove');
  assert.equal(approvals.requested.length, 1);
  const [dangerApproval] = approvals.requested;
  assert.ok(dangerApproval);
  assert.equal(dangerApproval.name, 'Danger');
});
