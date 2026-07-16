// 工具调用的审批门禁与计划模式守卫(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:在工具真正执行前拦一道闸——跑 pre_tool hook、处理 ExitPlanMode 计划批准、
//      计划模式下拦住未批准的写操作、按风险/变更性向用户申请逐次或会话级审批。
//      统一把"被阻止/拒绝"的结果写回 steps/messages 并广播事件。
// 依赖:同层 todo-state.js(从计划文本生成 todo 快照);其余靠注入的回调/注册表。
// 导出:ensureExitPlanModeTool / makeAudit / toolNeedsApproval /
//      runPreToolHook / handleExitPlanMode / blockUntilPlanApproved / requestToolApproval
import { todoItemsFromPlan } from './todo-state.js';
import { approvalScope, recordUnavailableApproval } from './approval-support.js';
import type { AgentTool, ApprovalRegistry, AuditBus, AuditFn, ExitPlanOptions, PlanBlockOptions, PreToolHookOptions, RequestContext, ToolApprovalOptions } from './approval-gate-types.js';

export type { AgentTool, ApprovalRegistry, AuditBus, AuditFn, EmitFn, ExitPlanOptions, HookBlock, HookEngine, MessageList, PlanBlockOptions, PreToolHookOptions, RequestContext, StepList, ToolApprovalOptions, ToolArgs, ToolCall, WorkspaceApprovedLike } from './approval-gate-types.js';

/** 计划模式下确保工具集里存在 ExitPlanMode 工具(只读,供模型提交计划草案)。 */
export function ensureExitPlanModeTool(agentTools: AgentTool[], planMode: boolean): void {
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

/** 生成审计函数:把每次事件连同请求上下文发往审计总线,失败静默吞掉不打断主循环。 */
export function makeAudit(auditBus: AuditBus | null | undefined, context: RequestContext = {}): AuditFn {
  return (kind, extra = {}) => {
    if (!auditBus) return;
    try { auditBus.publish({ kind, ...context, ...extra }); } catch { /* 审计失败不能打断工具主循环 */ }
  };
}

/** 判断某工具是否需要审批:显式 requiresApproval、会变更状态(mutating)、或风险 high/critical。 */
export function toolNeedsApproval(tool: AgentTool | null | undefined): boolean {
  const risk = String(tool?.risk || '').toLowerCase();
  return !!(tool && (tool.requiresApproval === true || tool.mutating === true || risk === 'high' || risk === 'critical'));
}

function isApprovedDecision(decision: unknown): decision is 'once' | 'session' {
  return decision === 'once' || decision === 'session';
}

/** 运行 pre_tool 钩子:若钩子判定阻止则写回阻止结果并返回 true(调用方据此跳过执行)。 */
export async function runPreToolHook({ hooks, name, args, steps, audit, emit, messages, call }: PreToolHookOptions): Promise<boolean> {
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

/** 处理 ExitPlanMode 调用:征求计划批准、记录审计、批准后据计划文本生成 todo 快照。 */
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
}: ExitPlanOptions): Promise<{ handled: boolean; planApproved: boolean }> {
  if (name !== 'ExitPlanMode') return { handled: false, planApproved: false };
  const plan = String((args && (args.plan || args.text)) || '').trim();
  if (!autoApprove && (!hasApprovals || !approvals)) {
    recordUnavailableApproval({ name, steps, audit, emit, messages, call },
      '计划必须经过显式审批，但当前审批服务不可用', 'plan.approval_unavailable', { chars: plan.length });
    return { handled: true, planApproved: false };
  }
  let approved = autoApprove;
  if (!autoApprove && approvals) {
    let approvalRequest: ReturnType<ApprovalRegistry['request']>;
    try {
      approvalRequest = approvals.request({ kind: 'plan', plan, runId, ...approvalScope(context) });
    } catch {
      recordUnavailableApproval({ name, steps, audit, emit, messages, call },
        '计划审批未能持久化，已失败关闭', 'plan.approval_persistence_failed', { chars: plan.length });
      return { handled: true, planApproved: false };
    }
    const { id, ready, promise } = approvalRequest;
    void promise.catch(() => undefined);
    try {
      if (ready) await ready;
    } catch {
      recordUnavailableApproval({ name, steps, audit, emit, messages, call },
        '计划审批未能持久化，已失败关闭', 'plan.approval_persistence_failed', { chars: plan.length });
      return { handled: true, planApproved: false };
    }
    emit('plan_proposed', { id, plan });
    audit('plan.proposed', { chars: plan.length });
    try {
      approved = isApprovedDecision(await promise);
    } catch {
      recordUnavailableApproval({ name, steps, audit, emit, messages, call },
        '计划审批未能持久化，已失败关闭', 'plan.approval_persistence_failed', { chars: plan.length });
      return { handled: true, planApproved: false };
    }
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

/** 计划模式且计划未批准时,拦住需审批的写操作并提示先用只读工具研究再提交计划。 */
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
}: PlanBlockOptions): boolean {
  if (!planMode || planApproved || !needsApproval) return false;
  const result = { error: '处于计划模式且计划尚未批准：请先用只读工具(Read/Glob/Grep/WebFetch)研究，然后调用 ExitPlanMode 提交计划草案，待用户批准后再执行写操作。' };
  steps.push({ tool: name, ok: false, planBlocked: true });
  audit('tool.plan_blocked', { tool: name, risk: tool ? tool.risk : undefined });
  emit('tool_result', { name, status: 'blocked', result });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
  return true;
}

/** 向用户申请单次工具审批:命中自动批准则放行,否则等待用户决定(可记会话级或工作区级)。 */
export async function requestToolApproval({
  needsApproval,
  hasApprovals,
  approvals,
  sessionApproved,
  workspaceApproved = null,
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
  context,
}: ToolApprovalOptions): Promise<boolean> {
  if (!needsApproval) return false;
  const risk = String(tool.risk || '').toLowerCase();
  const requiresExplicitApproval = tool.requiresApproval === true || risk === 'high' || risk === 'critical';
  if (!requiresExplicitApproval && sessionApproved.has(name)) return false;
  if (!requiresExplicitApproval && workspaceApproved?.has(name)) { audit('tool.auto_approved', { tool: name, risk: tool.risk, via: 'workspace_rule' }); return false; }
  if (autoApprove && !requiresExplicitApproval) {
    audit('tool.auto_approved', { tool: name, risk: tool.risk, via: 'auto' });
    return false;
  }
  if (!hasApprovals || !approvals) {
    const error = requiresExplicitApproval
      ? '该操作必须经过显式审批，但当前审批服务不可用'
      : '该变更操作需要审批，但当前审批服务不可用';
    recordUnavailableApproval({ name, steps, audit, emit, messages, call }, error,
      'tool.approval_unavailable', { tool: name, risk: tool.risk });
    return true;
  }
  const preview = tool.approvalPreview?.(args);
  const previewPayload = preview ? { preview } : {};
  let approvalRequest: ReturnType<ApprovalRegistry['request']>;
  try {
    approvalRequest = approvals.request({
      kind: 'tool',
      name,
      args,
      risk: tool.risk,
      runId,
      ...previewPayload,
      ...approvalScope(context),
    });
  } catch {
    recordUnavailableApproval({ name, steps, audit, emit, messages, call },
      '该操作的审批未能持久化，已阻止执行', 'tool.approval_persistence_failed', { tool: name, risk: tool.risk });
    return true;
  }
  const { id, ready, promise } = approvalRequest;
  void promise.catch(() => undefined);
  try {
    if (ready) await ready;
  } catch {
    recordUnavailableApproval({ name, steps, audit, emit, messages, call },
      '该操作的审批未能持久化，已阻止执行', 'tool.approval_persistence_failed', { tool: name, risk: tool.risk });
    return true;
  }
  emit('approval_request', {
    id,
    name,
    args,
    risk: tool.risk,
    sessionReusable: !requiresExplicitApproval,
    workspacePersistable: !requiresExplicitApproval && !!workspaceApproved,
    ...previewPayload,
  });
  let decision: string;
  try {
    decision = await promise;
  } catch {
    recordUnavailableApproval({ name, steps, audit, emit, messages, call },
      '该操作的审批未能持久化，已阻止执行', 'tool.approval_persistence_failed', { tool: name, risk: tool.risk });
    return true;
  }
  if (isApprovedDecision(decision) || decision === 'workspace') {
    // 显式审批工具(requiresApproval/high/critical)不允许任何形式的记住,一律降级为单次。
    let effectiveDecision = requiresExplicitApproval && decision !== 'once' ? 'once' : decision;
    if (effectiveDecision === 'workspace' && !workspaceApproved) effectiveDecision = 'session';
    if (effectiveDecision === 'session') sessionApproved.add(name);
    if (effectiveDecision === 'workspace') {
      sessionApproved.add(name);
      try { workspaceApproved?.add(name); } catch { /* 规则落盘失败不阻断本次已批准的执行 */ }
    }
    audit('tool.approved', {
      tool: name,
      risk: tool.risk,
      decision: effectiveDecision,
      ...(effectiveDecision !== decision ? { requestedDecision: decision } : {}),
    });
    return false;
  }
  const rejected = { error: '用户拒绝了该操作' };
  steps.push({ tool: name, ok: false, rejected: true });
  audit('tool.rejected', { tool: name, risk: tool.risk });
  emit('tool_result', { name, status: 'rejected', result: rejected });
  messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(rejected) });
  return true;
}
