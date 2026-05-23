import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { AuditEventBus } from '../src/runtime/audit-events.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-plan-')); }

// A scripted model: yields a preset list of assistant messages in order, then
// repeats the last one (a plain final answer) to end the loop.
function scriptedModel(script) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}
function toolCall(name, args) {
  return { content: '', tool_calls: [{ id: `c_${Math.random().toString(16).slice(2, 8)}`, function: { name, arguments: JSON.stringify(args || {}) } }] };
}

// Approvals stub that resolves each request with a queued decision and records
// what was asked, so tests can assert which tools actually hit the gate.
function queuedApprovals(decisions) {
  const q = [...decisions];
  const requested = [];
  return {
    requested,
    request(meta) {
      requested.push(meta);
      const decision = q.length ? q.shift() : 'once';
      return { id: `apr_${requested.length}`, promise: Promise.resolve(decision) };
    },
  };
}

function collectAudit() {
  const events = [];
  const bus = new AuditEventBus();
  bus.subscribe((e) => { events.push(e); });
  return { bus, events };
}

test('plan mode blocks mutating tools until ExitPlanMode is approved', async () => {
  const root = tmp();
  const { bus, events } = collectAudit();
  const approvals = queuedApprovals(['once']); // approve the plan
  const model = scriptedModel([
    toolCall('Write', { path: 'a.txt', content: 'before-plan' }), // blocked: no approved plan yet
    toolCall('ExitPlanMode', { plan: '步骤1：写 a.txt；步骤2：汇报。' }), // approved
    toolCall('Write', { path: 'a.txt', content: 'after-plan' }), // plan-authorized (non-high) → runs
    { content: '完成。' },
  ]);
  const out = await runAgentChat({
    prompt: '建 a.txt', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall: model,
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
  assert.ok(kinds.includes('tool.auto_approved'), 'post-plan write authorized by the approved plan');
  // The plan went through the approval registry exactly once.
  assert.equal(approvals.requested.length, 1);
  assert.equal(approvals.requested[0].kind, 'plan');
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
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall: model,
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
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall: model,
    approvals, runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false, 'a rejected Write must not happen');
  assert.equal(approvals.requested.length, 1);
  assert.equal(approvals.requested[0].name, 'Write');
});

test('autoApprove covers non-high mutations but high-risk stays explicit', async () => {
  const root = tmp();
  let dangerRan = 0;
  const approvals = queuedApprovals(['reject']); // reject the high-risk call
  const customTools = [
    { name: 'Write', risk: 'write', mutating: true, description: 'w', parameters: { type: 'object', properties: {} }, handler: async () => { fs.writeFileSync(path.join(root, 'd.txt'), 'y'); return { ok: true }; } },
    { name: 'Danger', risk: 'high', mutating: true, description: 'd', parameters: { type: 'object', properties: {} }, handler: async () => { dangerRan += 1; return { ok: true }; } },
  ];
  const model = scriptedModel([
    toolCall('Write', {}), // non-high → autoApprove runs it without a prompt
    toolCall('Danger', {}), // high-risk → must hit the approval gate → rejected → does not run
    { content: '完成。' },
  ]);
  await runAgentChat({
    prompt: 'x', kimiConfig: { model: 'fake' }, trustedRoot: root, modelCall: model,
    tools: customTools, approvals, autoApprove: true, runStoreRoot: path.join(root, 'runs'),
  });
  assert.equal(fs.existsSync(path.join(root, 'd.txt')), true, 'non-high write auto-approved under autoApprove');
  assert.equal(dangerRan, 0, 'high-risk must NOT auto-run under autoApprove');
  assert.equal(approvals.requested.length, 1);
  assert.equal(approvals.requested[0].name, 'Danger');
});
