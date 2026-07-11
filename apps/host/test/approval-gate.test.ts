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
    args: { command: 'npm test' },
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

test('ExitPlanMode fails closed when the approval registry is unavailable', async () => {
  const events: Event[] = [];
  const steps: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];

  const result = await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: '- 修改安全配置' },
    hasApprovals: false,
    autoApprove: false,
    approvals: null,
    emit: emitTo(events),
    audit: auditTo(events),
    steps,
    messages,
    call: { id: 'call_missing_registry' },
  });

  assert.deepEqual(result, { handled: true, planApproved: false });
  assert.deepEqual(steps[0], { tool: 'ExitPlanMode', ok: false, approvalUnavailable: true });
  assert.equal(events.at(-2)?.payload.kind, 'plan.approval_unavailable');
  assert.deepEqual(events.at(-1)?.payload, {
    name: 'ExitPlanMode',
    status: 'blocked',
    result: { error: '计划必须经过显式审批，但当前审批服务不可用', code: 'APPROVAL_REQUIRED' },
  });
  assert.match(String(messages[0]?.content), /APPROVAL_REQUIRED/);
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

  const lowRiskRequests: Record<string, unknown>[] = [];
  assert.equal(await requestToolApproval({
    ...base,
    needsApproval: true,
    approvals: approval('session', lowRiskRequests),
  }), false);
  assert.equal(sessionApproved.has('Write'), true);
  assert.equal(lowRiskRequests.length, 1);
  sessionApproved.clear();

  const requests: Record<string, unknown>[] = [];
  assert.equal(await requestToolApproval({
    ...base,
    needsApproval: true,
    approvals: approval('session', requests),
    tool: { name: 'Shell', risk: 'high', mutating: true },
    name: 'Shell',
    args: { command: 'npm test' },
  }), false);
  assert.deepEqual(requests[0], {
    kind: 'tool',
    name: 'Shell',
    args: { command: 'npm test' },
    risk: 'high',
    runId: 'run_1',
    tenantId: 'tenant-a',
    userId: 'user-a',
  });
  assert.equal(sessionApproved.has('Shell'), false, 'high-risk approvals must never enter the reusable session cache');
  assert.equal(events.at(-2)?.type, 'approval_request');
  assert.equal(events.at(-2)?.payload.sessionReusable, false);
  assert.equal(events.at(-1)?.payload.kind, 'tool.approved');
  assert.equal(events.at(-1)?.payload.decision, 'once');
  assert.equal(events.at(-1)?.payload.requestedDecision, 'session');

  sessionApproved.add('Shell'); // legacy checkpoint/cache entry must not bypass an explicit approval.
  assert.equal(await requestToolApproval({
    ...base,
    needsApproval: true,
    approvals: approval('once', requests),
    tool: { name: 'Shell', risk: 'high', mutating: true },
    name: 'Shell',
    args: { command: 'npm publish' },
  }), false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.args, { command: 'npm publish' });
  sessionApproved.delete('Shell');

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

test('explicit requiresApproval metadata cannot be bypassed by auto or plan approval', async () => {
  const requests: Record<string, unknown>[] = [];
  const events: Event[] = [];
  const base = {
    needsApproval: true,
    hasApprovals: true,
    approvals: approval('once', requests),
    sessionApproved: new Set<string>(),
    name: 'ExportPreview',
    args: { destination: 'report.pdf' },
    tool: { name: 'ExportPreview', risk: 'low', requiresApproval: true },
    emit: emitTo(events),
    audit: auditTo(events),
    steps: [] as Record<string, unknown>[],
    messages: [] as Record<string, unknown>[],
    call: { id: 'call_explicit' },
  };

  assert.equal(await requestToolApproval({
    ...base,
    autoApprove: true,
    planMode: false,
    planApproved: false,
  }), false);
  assert.equal(requests.length, 1, 'autoApprove must still request explicit approval');

  assert.equal(await requestToolApproval({
    ...base,
    autoApprove: false,
    planMode: true,
    planApproved: true,
  }), false);
  assert.equal(requests.length, 2, 'an approved plan must still request explicit tool approval');
  assert.equal(events.filter((event) => event.type === 'approval_request').length, 2);
});

test('approval gate treats unknown registry values as rejection', async () => {
  const planSteps: Record<string, unknown>[] = [];
  const planMessages: Record<string, unknown>[] = [];
  const planEvents: Event[] = [];
  assert.deepEqual(await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: 'write files' },
    hasApprovals: true,
    autoApprove: false,
    approvals: approval('unexpected'),
    emit: emitTo(planEvents),
    audit: auditTo(planEvents),
    steps: planSteps,
    messages: planMessages,
    call: { id: 'call_plan_unknown' },
  }), { handled: true, planApproved: false });
  assert.equal(planEvents.some((event) => event.payload.kind === 'plan.rejected'), true);

  const toolSteps: Record<string, unknown>[] = [];
  const toolMessages: Record<string, unknown>[] = [];
  const toolEvents: Event[] = [];
  assert.equal(await requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: approval('unexpected'),
    sessionApproved: new Set<string>(),
    name: 'Shell',
    args: { command: 'npm test' },
    tool: { name: 'Shell', risk: 'high', mutating: true },
    emit: emitTo(toolEvents),
    audit: auditTo(toolEvents),
    steps: toolSteps,
    messages: toolMessages,
    call: { id: 'call_tool_unknown' },
    autoApprove: false,
    planMode: false,
    planApproved: false,
  }), true);
  assert.deepEqual(toolSteps[0], { tool: 'Shell', ok: false, rejected: true });
  assert.equal(toolEvents.some((event) => event.payload.kind === 'tool.rejected'), true);
});

test('approval persistence failures fail closed for plan and tool requests', async () => {
  const planEvents: Event[] = [];
  const planSteps: Record<string, unknown>[] = [];
  const planMessages: Record<string, unknown>[] = [];
  const failedPlanApprovals: ApprovalRegistry = {
    request: () => ({
      id: 'approval_plan_failed',
      promise: Promise.reject(new Error('postgres persistence unavailable')),
    }),
  };

  assert.deepEqual(await handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: '修改安全配置' },
    hasApprovals: true,
    autoApprove: false,
    approvals: failedPlanApprovals,
    emit: emitTo(planEvents),
    audit: auditTo(planEvents),
    steps: planSteps,
    messages: planMessages,
    call: { id: 'call_plan_persistence_failed' },
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  }), { handled: true, planApproved: false });
  assert.deepEqual(planSteps, [{ tool: 'ExitPlanMode', ok: false, approvalUnavailable: true }]);
  assert.equal(planEvents.some((event) => event.payload.kind === 'plan.approval_persistence_failed'), true);
  assert.match(String(planMessages[0]?.content), /APPROVAL_REQUIRED/);
  assert.doesNotMatch(String(planMessages[0]?.content), /postgres/i);

  const toolEvents: Event[] = [];
  const toolSteps: Record<string, unknown>[] = [];
  const toolMessages: Record<string, unknown>[] = [];
  const failedToolApprovals: ApprovalRegistry = {
    request: () => { throw new Error('postgres request failed'); },
  };
  assert.equal(await requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: failedToolApprovals,
    sessionApproved: new Set<string>(),
    name: 'Shell',
    args: { command: 'npm test' },
    tool: { name: 'Shell', risk: 'high', mutating: true },
    emit: emitTo(toolEvents),
    audit: auditTo(toolEvents),
    steps: toolSteps,
    messages: toolMessages,
    call: { id: 'call_tool_persistence_failed' },
    autoApprove: false,
    planMode: false,
    planApproved: false,
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  }), true);
  assert.deepEqual(toolSteps, [{ tool: 'Shell', ok: false, approvalUnavailable: true }]);
  assert.equal(toolEvents.some((event) => event.payload.kind === 'tool.approval_persistence_failed'), true);
  assert.match(String(toolMessages[0]?.content), /APPROVAL_REQUIRED/);
  assert.doesNotMatch(String(toolMessages[0]?.content), /postgres/i);
});

test('approval request and readiness failures stay fail closed at every durable boundary', async () => {
  const planRegistries: Array<{ stage: string; registry: ApprovalRegistry }> = [
    {
      stage: 'request',
      registry: { request: () => { throw new Error('request failed'); } },
    },
    {
      stage: 'ready',
      registry: {
        request: () => ({
          id: 'approval_plan_not_ready',
          ready: Promise.reject(new Error('ready failed')),
          promise: Promise.resolve('once'),
        }),
      },
    },
  ];

  for (const { stage, registry } of planRegistries) {
    const events: Event[] = [];
    const steps: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    assert.deepEqual(await handleExitPlanMode({
      name: 'ExitPlanMode',
      args: {},
      hasApprovals: true,
      autoApprove: false,
      approvals: registry,
      emit: emitTo(events),
      audit: auditTo(events),
      steps,
      messages,
      call: { id: `call_plan_${stage}` },
    }), { handled: true, planApproved: false });
    assert.deepEqual(steps, [{ tool: 'ExitPlanMode', ok: false, approvalUnavailable: true }]);
    assert.equal(events.some((event) => event.type === 'plan_proposed'), false);
    assert.equal(events.some((event) => event.payload.kind === 'plan.approval_persistence_failed'), true);
    assert.match(String(messages[0]?.content), /APPROVAL_REQUIRED/);
  }

  const toolRegistries: Array<{ stage: string; registry: ApprovalRegistry }> = [
    {
      stage: 'ready',
      registry: {
        request: () => ({
          id: 'approval_tool_not_ready',
          ready: Promise.reject(new Error('ready failed')),
          promise: Promise.resolve('once'),
        }),
      },
    },
    {
      stage: 'decision',
      registry: {
        request: () => ({
          id: 'approval_tool_decision_failed',
          promise: Promise.reject(new Error('decision failed')),
        }),
      },
    },
  ];

  for (const { stage, registry } of toolRegistries) {
    const events: Event[] = [];
    const steps: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    assert.equal(await requestToolApproval({
      needsApproval: true,
      hasApprovals: true,
      approvals: registry,
      sessionApproved: new Set<string>(),
      name: 'Shell',
      args: { command: 'npm test' },
      tool: { name: 'Shell', risk: 'high', mutating: true },
      emit: emitTo(events),
      audit: auditTo(events),
      steps,
      messages,
      call: { id: `call_tool_${stage}` },
      autoApprove: false,
      planMode: false,
      planApproved: false,
    }), true);
    assert.deepEqual(steps, [{ tool: 'Shell', ok: false, approvalUnavailable: true }]);
    assert.equal(events.some((event) => event.payload.kind === 'tool.approval_persistence_failed'), true);
    assert.match(String(messages[0]?.content), /APPROVAL_REQUIRED/);
  }
});

test('tool approval includes an explicit preview in the durable request and event', async () => {
  const events: Event[] = [];
  const requests: Record<string, unknown>[] = [];
  assert.equal(await requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: approval('once', requests),
    sessionApproved: new Set<string>(),
    name: 'Write',
    args: { path: 'report.md' },
    tool: {
      name: 'Write',
      risk: 'low',
      mutating: true,
      approvalPreview: (args) => ({ path: args.path, operation: 'write' }),
    },
    emit: emitTo(events),
    audit: auditTo(events),
    steps: [],
    messages: [],
    call: { id: 'call_preview' },
    autoApprove: false,
    planMode: false,
    planApproved: false,
  }), false);

  const preview = { path: 'report.md', operation: 'write' };
  assert.deepEqual(requests[0]?.preview, preview);
  assert.deepEqual(events.find((event) => event.type === 'approval_request')?.payload.preview, preview);
});

test('approval events are not published before durable readiness', async () => {
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const registry = {
    request: () => ({ id: 'approval_ready', ready, promise: Promise.resolve('once') }),
  } as ApprovalRegistry;

  const planEvents: Event[] = [];
  const planResult = handleExitPlanMode({
    name: 'ExitPlanMode',
    args: { plan: '修改配置' },
    hasApprovals: true,
    autoApprove: false,
    approvals: registry,
    emit: emitTo(planEvents),
    audit: auditTo(planEvents),
    steps: [],
    messages: [],
    call: { id: 'call_plan_ready' },
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(planEvents.some((event) => event.type === 'plan_proposed'), false);
  markReady?.();
  assert.deepEqual(await planResult, { handled: true, planApproved: true });

  let markToolReady: (() => void) | undefined;
  const toolReady = new Promise<void>((resolve) => { markToolReady = resolve; });
  const toolEvents: Event[] = [];
  const toolResult = requestToolApproval({
    needsApproval: true,
    hasApprovals: true,
    approvals: {
      request: () => ({ id: 'tool_ready', ready: toolReady, promise: Promise.resolve('once') }),
    } as ApprovalRegistry,
    sessionApproved: new Set<string>(),
    name: 'Shell',
    args: { command: 'npm test' },
    tool: { name: 'Shell', risk: 'high', mutating: true },
    emit: emitTo(toolEvents),
    audit: auditTo(toolEvents),
    steps: [],
    messages: [],
    call: { id: 'call_tool_ready' },
    autoApprove: false,
    planMode: false,
    planApproved: false,
    context: { tenantId: 'tenant-a', userId: 'user-a' },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(toolEvents.some((event) => event.type === 'approval_request'), false);
  markToolReady?.();
  assert.equal(await toolResult, false);
});
