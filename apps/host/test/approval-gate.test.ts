import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blockUntilPlanApproved,
  ensureExitPlanModeTool,
  handleExitPlanMode,
  makeAudit,
  requestToolApproval,
  runPreToolHook,
  toolNeedsApproval,
  type AgentTool,
  type ApprovalRegistry,
} from '../src/kimi/agent/approval-gate.js';

type Event = { type: string; payload: Record<string, unknown> };

function emitTo(events: Event[]) {
  return (type: string, payload: Record<string, unknown>) => { events.push({ type, payload }); };
}

function auditTo(events: Event[]) {
  return (kind: string, extra: Record<string, unknown> = {}) => { events.push({ type: 'audit', payload: { kind, ...extra } }); };
}

function approval(decision: string, requests: Record<string, unknown>[] = []): ApprovalRegistry {
  return {
    request: (payload) => {
      requests.push(payload);
      return { id: `approval_${requests.length}`, promise: Promise.resolve(decision) };
    },
  };
}

test('approval gate basics expose ExitPlanMode once and classify approval risk', async () => {
  const tools: AgentTool[] = [];
  ensureExitPlanModeTool(tools, false);
  assert.equal(tools.length, 0);
  ensureExitPlanModeTool(tools, true);
  ensureExitPlanModeTool(tools, true);
  assert.equal(tools.filter((tool) => tool.name === 'ExitPlanMode').length, 1);
  assert.deepEqual(await tools[0]?.handler?.({ plan: 'x' }), { note: 'plan handled by agent loop' });

  assert.equal(toolNeedsApproval(null), false);
  assert.equal(toolNeedsApproval({ name: 'Read', risk: 'safe' }), false);
  assert.equal(toolNeedsApproval({ name: 'Write', mutating: true }), true);
  assert.equal(toolNeedsApproval({ name: 'Shell', risk: 'HIGH' }), true);
  assert.equal(toolNeedsApproval({ name: 'Vault', risk: 'critical' }), true);
  assert.equal(toolNeedsApproval({ name: 'Receipt', requiresApproval: true }), true);

  const auditEvents: Record<string, unknown>[] = [];
  const audit = makeAudit({ publish: (payload) => { auditEvents.push(payload); } }, { tenantId: 't1' });
  audit('tool.checked', { tool: 'Read' });
  assert.deepEqual(auditEvents, [{ kind: 'tool.checked', tenantId: 't1', tool: 'Read' }]);
  assert.doesNotThrow(() => makeAudit({ publish: () => { throw new Error('audit sink down'); } })('ignored'));
  assert.doesNotThrow(() => makeAudit(null)('ignored'));
});

test('pre-tool hook writes a blocked tool result and leaves allowed tools untouched', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  assert.equal(await runPreToolHook({
    hooks: null,
    name: 'Read',
    args: {},
    steps,
    audit: auditTo(events),
    emit: emitTo(events),
    messages,
    call: { id: 'call_1' },
  }), false);

  assert.equal(await runPreToolHook({
    hooks: {
      run: async () => ({ ok: true }),
      blocked: () => false,
    },
    name: 'Read',
    args: { path: 'a.txt' },
    steps,
    audit: auditTo(events),
    emit: emitTo(events),
    messages,
    call: { id: 'call_2' },
  }), false);

  assert.equal(await runPreToolHook({
    hooks: {
      run: async (_event, payload) => payload,
      blocked: () => ({ reason: 'policy denied' }),
    },
    name: 'Shell',
    args: { command: 'npm test' },
    steps,
    audit: auditTo(events),
    emit: emitTo(events),
    messages,
    call: { id: 'call_3' },
  }), true);
  assert.deepEqual(steps.at(-1), { tool: 'Shell', ok: false, blocked: true });
  assert.deepEqual(events.at(-2), { type: 'audit', payload: { kind: 'tool.hook_blocked', tool: 'Shell', reason: 'policy denied' } });
  assert.deepEqual(events.at(-1)?.payload, { name: 'Shell', status: 'blocked', result: { error: '被 hook 阻止：policy denied' } });
  assert.match(String(messages.at(-1)?.content), /policy denied/);
});

test('ExitPlanMode approval emits todos, records rejection, and ignores other tools', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  assert.deepEqual(await handleExitPlanMode({
    name: 'Read',
    args: {},
    hasApprovals: false,
    autoApprove: false,
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_read' },
  }), { handled: false, planApproved: false });

  const approvedRequests: Record<string, unknown>[] = [];
  assert.deepEqual(await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { text: '1. 写 README\n- 验证 npm run check' },
    hasApprovals: true,
    autoApprove: false,
    approvals: approval('once', approvedRequests),
    runId: 'run_1',
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_plan' },
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  }), { handled: true, planApproved: true });
  assert.deepEqual(approvedRequests[0], {
    kind: 'plan',
    plan: '1. 写 README\n- 验证 npm run check',
    runId: 'run_1',
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  assert.equal(events.some((event) => event.type === 'todo_snapshot'), true);
  assert.deepEqual(steps.at(-1), { tool: 'ExitPlanMode', ok: true, plan: true, approved: true });

  const rejectedSteps: Record<string, unknown>[] = [];
  const rejectedMessages: Record<string, unknown>[] = [];
  const rejectedEvents: Event[] = [];
  assert.deepEqual(await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: '改配置' },
    hasApprovals: true,
    autoApprove: false,
    approvals: approval('reject'),
    emit: emitTo(rejectedEvents),
    audit: auditTo(rejectedEvents),
    steps: rejectedSteps,
    messages: rejectedMessages,
    call: { id: 'call_reject' },
  }), { handled: true, planApproved: false });
  assert.deepEqual(rejectedSteps[0], { tool: 'ExitPlanMode', ok: true, plan: true, approved: false });
  assert.equal(rejectedEvents.some((event) => event.payload.kind === 'plan.rejected'), true);
  assert.match(String(rejectedMessages[0]?.content), /继续完善计划/);
});

test('ExitPlanMode auto approval still writes the tool response and todo snapshot', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];

  const result = await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: '- 写回归测试\n- 跑覆盖率门禁' },
    hasApprovals: true,
    autoApprove: true,
    approvals: null,
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_auto_plan' },
  });

  assert.deepEqual(result, { handled: true, planApproved: true });
  assert.deepEqual(steps[0], { tool: 'ExitPlanMode', ok: true, plan: true, approved: true });
  assert.equal(events.some((event) => event.type === 'todo_snapshot'), true);
  assert.equal(events.at(-1)?.type, 'tool_result');
  assert.match(String(messages[0]?.content), /计划已批准/);
});

test('plan-mode block writes a tool result only before approval', () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const base = {
    name: 'Write',
    tool: { name: 'Write', risk: 'low', mutating: true },
    steps,
    audit: auditTo(events),
    emit: emitTo(events),
    messages,
    call: { id: 'call_write' },
  };
  assert.equal(blockUntilPlanApproved({ ...base, planMode: false, planApproved: false, needsApproval: true }), false);
  assert.equal(blockUntilPlanApproved({ ...base, planMode: true, planApproved: true, needsApproval: true }), false);
  assert.equal(blockUntilPlanApproved({ ...base, planMode: true, planApproved: false, needsApproval: false }), false);
  assert.equal(blockUntilPlanApproved({ ...base, planMode: true, planApproved: false, needsApproval: true }), true);
  assert.deepEqual(steps[0], { tool: 'Write', ok: false, planBlocked: true });
  assert.deepEqual(events.at(-2), { type: 'audit', payload: { kind: 'tool.plan_blocked', tool: 'Write', risk: 'low' } });
  assert.deepEqual(events.at(-1)?.payload, { name: 'Write', status: 'blocked', result: { error: '处于计划模式且计划尚未批准：请先用只读工具(Read/Glob/Grep/WebFetch)研究，然后调用 ExitPlanMode 提交计划草案，待用户批准后再执行写操作。' } });
  assert.match(String(messages[0]?.content), /计划尚未批准/);
});

test('tool approval handles early exits, auto approval, session approval, and rejection', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const sessionApproved = new Set<string>();
  const tool: AgentTool = { name: 'Write', risk: 'low', mutating: true };
  const base = {
    hasApprovals: true,
    approvals: approval('once'),
    sessionApproved,
    name: 'Write',
    args: { path: 'a.txt' },
    tool,
    runId: 'run_1',
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_write' },
    autoApprove: false,
    planMode: false,
    planApproved: false,
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  };

  assert.equal(await requestToolApproval({ ...base, needsApproval: false }), false);
  sessionApproved.add('Write');
  assert.equal(await requestToolApproval({ ...base, needsApproval: true }), false);
  sessionApproved.clear();
  assert.equal(await requestToolApproval({ ...base, needsApproval: true, autoApprove: true }), false);
  assert.equal(events.at(-1)?.payload.kind, 'tool.auto_approved');
  assert.equal(events.at(-1)?.payload.via, 'auto');
  assert.equal(await requestToolApproval({ ...base, needsApproval: true, planMode: true, planApproved: true }), false);
  assert.equal(events.at(-1)?.payload.via, 'plan');

  const requests: Record<string, unknown>[] = [];
  assert.equal(await requestToolApproval({
    ...base,
    needsApproval: true,
    approvals: approval('session', requests),
    tool: { name: 'Shell', risk: 'high', mutating: true },
    name: 'Shell',
  }), false);
  assert.deepEqual(requests[0], {
    name: 'Shell',
    args: { path: 'a.txt' },
    risk: 'high',
    runId: 'run_1',
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  assert.equal(sessionApproved.has('Shell'), true);
  assert.equal(events.at(-2)?.type, 'approval_request');
  assert.equal(events.at(-1)?.payload.kind, 'tool.approved');

  const rejectedMessages: Record<string, unknown>[] = [];
  const rejectedSteps: Record<string, unknown>[] = [];
  const rejectedEvents: Event[] = [];
  assert.equal(await requestToolApproval({
    ...base,
    needsApproval: true,
    approvals: approval('reject'),
    tool: { name: 'Shell', risk: 'high', mutating: true },
    name: 'Shell',
    sessionApproved: new Set<string>(),
    emit: emitTo(rejectedEvents),
    audit: auditTo(rejectedEvents),
    steps: rejectedSteps,
    messages: rejectedMessages,
  }), true);
  assert.deepEqual(rejectedSteps[0], { tool: 'Shell', ok: false, rejected: true });
  assert.equal(rejectedEvents.some((event) => event.payload.kind === 'tool.rejected'), true);
  assert.match(String(rejectedMessages[0]?.content), /用户拒绝/);
});

test('high-risk and critical tools still require approval requests despite auto or plan approval', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];

  assert.equal(await requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: approval('once', requests),
    sessionApproved: new Set<string>(),
    name: 'Shell',
    args: { command: 'npm test' },
    tool: { name: 'Shell', risk: 'HIGH', mutating: true },
    runId: 'run_high',
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_high' },
    autoApprove: true,
    planMode: true,
    planApproved: true,
    context: { tenantId: 'tenant-a' },
  }), false);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.name, 'Shell');
  assert.equal(requests[0]?.risk, 'HIGH');
  assert.equal(events.at(-2)?.type, 'approval_request');
  assert.equal(events.at(-1)?.payload.kind, 'tool.approved');
  assert.equal(steps.length, 0, 'approved high-risk tools should not write a rejection step');
  assert.equal(messages.length, 0, 'approved high-risk tools should not write a tool rejection message');

  assert.equal(await requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: approval('once', requests),
    sessionApproved: new Set<string>(),
    name: 'VaultWrite',
    args: { path: 'secret.txt' },
    tool: { name: 'VaultWrite', risk: 'critical', mutating: true },
    runId: 'run_critical',
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_critical' },
    autoApprove: true,
    planMode: true,
    planApproved: true,
    context: { tenantId: 'tenant-a' },
  }), false);

  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.name, 'VaultWrite');
  assert.equal(requests[1]?.risk, 'critical');
});
