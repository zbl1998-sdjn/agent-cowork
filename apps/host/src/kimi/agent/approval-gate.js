import { todoItemsFromPlan } from './todo-state.js';

export function ensureExitPlanModeTool(agentTools, planMode) {
  if (!planMode || agentTools.some((t) => t.name === 'ExitPlanMode')) return;
  agentTools.push({
    name: 'ExitPlanMode',
    mutating: false,
    risk: 'safe',
    description: '提交一份中文计划草案，等待用户批准后再执行。参数 plan 为计划文本（说明做什么、改哪些文件、分几步）。',
    parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    handler: async () => ({ note: 'plan handled by agent loop' }),
  });
}

export function makeAudit(auditBus, context) {
  return (kind, extra = {}) => {
    if (!auditBus) return;
    try { auditBus.publish({ kind, ...(context || {}), ...extra }); } catch { /* swallow */ }
  };
}

export function toolNeedsApproval(tool) {
  return !!(tool && (tool.mutating === true || tool.risk === 'high'));
}

function approvalScope(context = {}) {
  return {
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

export async function runPreToolHook({ hooks, name, args, steps, audit, emit, messages, call }) {
  if (!hooks) return false;
  const blockedByHook = hooks.blocked(await hooks.run('pre_tool', { name, args }));
  if (!blockedByHook) return false;
  const result = { error: `被 hook 阻止：${blockedByHook.reason || ''}` };
  steps.push({ tool: name, ok: false, blocked: true });
  audit('tool.hook_blocked', { tool: name, reason: blockedByHook.reason || '' });
  emit('tool_result', { name, status: 'blocked', result });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  return true;
}

export async function handleExitPlanMode({
  name,
  args,
  hasApprovals,
  autoApprove,
  approvals,
  runId,
  emit,
  audit,
  steps,
  messages,
  call,
  context,
}) {
  if (name !== 'ExitPlanMode') return { handled: false, planApproved: false };
  const plan = String((args && (args.plan || args.text)) || '').trim();
  let approved = true;
  if (hasApprovals && !autoApprove) {
    const { id, promise } = approvals.request({ kind: 'plan', plan, runId, ...approvalScope(context) });
    emit('plan_proposed', { id, plan });
    audit('plan.proposed', { chars: plan.length });
    approved = await promise !== 'reject';
  }
  const result = approved
    ? { approved: true, note: '计划已批准，现在按计划执行。' }
    : { approved: false, note: '用户希望继续完善计划。请根据反馈修订后再次调用 ExitPlanMode。' };
  steps.push({ tool: name, ok: true, plan: true, approved });
  audit(approved ? 'plan.approved' : 'plan.rejected', { chars: plan.length });
  if (approved) {
    const items = todoItemsFromPlan(plan);
    if (items.length) emit('todo_snapshot', { todos: items });
  }
  emit('tool_result', { name, status: 'succeeded', result });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  return { handled: true, planApproved: approved };
}

export function blockUntilPlanApproved({
  planMode,
  planApproved,
  needsApproval,
  name,
  tool,
  steps,
  audit,
  emit,
  messages,
  call,
}) {
  if (!planMode || planApproved || !needsApproval) return false;
  const result = { error: '处于计划模式且计划尚未批准：请先用只读工具(Read/Glob/Grep/WebFetch)研究，然后调用 ExitPlanMode 提交计划草案，待用户批准后再执行写操作。' };
  steps.push({ tool: name, ok: false, planBlocked: true });
  audit('tool.plan_blocked', { tool: name, risk: tool ? tool.risk : undefined });
  emit('tool_result', { name, status: 'blocked', result });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  return true;
}

export async function requestToolApproval({
  needsApproval,
  hasApprovals,
  approvals,
  sessionApproved,
  name,
  args,
  tool,
  runId,
  emit,
  audit,
  steps,
  messages,
  call,
  autoApprove,
  planMode,
  planApproved,
  context,
}) {
  if (!needsApproval || !hasApprovals || sessionApproved.has(name)) return false;
  const planAuthorized = planMode && planApproved;
  if ((autoApprove || planAuthorized) && tool.risk !== 'high') {
    audit('tool.auto_approved', { tool: name, risk: tool.risk, via: autoApprove ? 'auto' : 'plan' });
    return false;
  }
  const { id, promise } = approvals.request({ name, args, risk: tool.risk, runId, ...approvalScope(context) });
  emit('approval_request', { id, name, args, risk: tool.risk });
  const decision = await promise;
  if (decision === 'session') sessionApproved.add(name);
  if (decision !== 'reject') {
    audit('tool.approved', { tool: name, risk: tool.risk, decision });
    return false;
  }
  const rejected = { error: '用户拒绝了该操作' };
  steps.push({ tool: name, ok: false, rejected: true });
  audit('tool.rejected', { tool: name, risk: tool.risk });
  emit('tool_result', { name, status: 'rejected', result: rejected });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(rejected) });
  return true;
}
