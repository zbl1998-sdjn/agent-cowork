// @ts-check
// 工具调用的审批门禁与计划模式守卫(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:在工具真正执行前拦一道闸——跑 pre_tool hook、处理 ExitPlanMode 计划批准、
//      计划模式下拦住未批准的写操作、按风险/变更性向用户申请逐次或会话级审批。
//      统一把"被阻止/拒绝"的结果写回 steps/messages 并广播事件。
// 依赖:同层 todo-state.js(从计划文本生成 todo 快照);其余靠注入的回调/注册表。
// 导出:ensureExitPlanModeTool / makeAudit / toolNeedsApproval /
//      runPreToolHook / handleExitPlanMode / blockUntilPlanApproved / requestToolApproval
import { todoItemsFromPlan } from './todo-state.js';

/**
 * @typedef {Record<string, unknown>} ToolArgs
 * @typedef {{ name: string, mutating?: boolean, risk?: string, requiresApproval?: boolean, description?: string, parameters?: unknown, handler?: (args?: ToolArgs) => unknown | Promise<unknown> }} AgentTool
 * @typedef {{ publish(payload: Record<string, unknown>): unknown }} AuditBus
 * @typedef {(kind: string, extra?: Record<string, unknown>) => void} AuditFn
 * @typedef {(type: string, payload: Record<string, unknown>) => void} EmitFn
 * @typedef {{ id?: unknown }} ToolCall
 * @typedef {Array<Record<string, unknown>>} StepList
 * @typedef {Array<Record<string, unknown>>} MessageList
 * @typedef {{ tenantId?: unknown, userId?: unknown, [key: string]: unknown }} RequestContext
 * @typedef {{ reason?: string }} HookBlock
 * @typedef {{ run(event: string, payload: Record<string, unknown>): unknown | Promise<unknown>, blocked(result: unknown): false | HookBlock }} HookEngine
 * @typedef {{ request(payload: Record<string, unknown>): { id: string, promise: Promise<string> } }} ApprovalRegistry
 * @typedef {{ hooks?: HookEngine | null, name: string, args: ToolArgs, steps: StepList, audit: AuditFn, emit: EmitFn, messages: MessageList, call: ToolCall }} PreToolHookOptions
 * @typedef {{ name: string, args: ToolArgs, hasApprovals: boolean, autoApprove: boolean, approvals?: ApprovalRegistry | null, runId?: unknown, emit: EmitFn, audit: AuditFn, steps: StepList, messages: MessageList, call: ToolCall, context?: RequestContext }} ExitPlanOptions
 * @typedef {{ planMode: boolean, planApproved: boolean, needsApproval: boolean, name: string, tool?: AgentTool | null, steps: StepList, audit: AuditFn, emit: EmitFn, messages: MessageList, call: ToolCall }} PlanBlockOptions
 * @typedef {{ needsApproval: boolean, hasApprovals: boolean, approvals?: ApprovalRegistry | null, sessionApproved: Set<string>, name: string, args: ToolArgs, tool: AgentTool, runId?: unknown, emit: EmitFn, audit: AuditFn, steps: StepList, messages: MessageList, call: ToolCall, autoApprove: boolean, planMode: boolean, planApproved: boolean, context?: RequestContext }} ToolApprovalOptions
 */

/** 计划模式下确保工具集里存在 ExitPlanMode 工具(只读,供模型提交计划草案)。 @param {AgentTool[]} agentTools @param {boolean} planMode */
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

/** 生成审计函数:把每次事件连同请求上下文发往审计总线,失败静默吞掉不打断主循环。 @param {AuditBus | null | undefined} auditBus @param {RequestContext} [context] @returns {AuditFn} */
export function makeAudit(auditBus, context) {
  return (kind, extra = {}) => {
    if (!auditBus) return;
    try { auditBus.publish({ kind, ...(context || {}), ...extra }); } catch { /* swallow */ }
  };
}

/** 判断某工具是否需要审批:显式 requiresApproval、会变更状态(mutating)、或风险 high/critical。 @param {AgentTool | null | undefined} tool */
export function toolNeedsApproval(tool) {
  const risk = String(tool?.risk || '').toLowerCase();
  return !!(tool && (tool.requiresApproval === true || tool.mutating === true || risk === 'high' || risk === 'critical'));
}

/** @param {RequestContext} [context] */
function approvalScope(context = {}) {
  return {
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

/** 运行 pre_tool 钩子:若钩子判定阻止则写回阻止结果并返回 true(调用方据此跳过执行)。 @param {PreToolHookOptions} options */
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

/** 处理 ExitPlanMode 调用:征求计划批准、记录审计、批准后据计划文本生成 todo 快照。 @param {ExitPlanOptions} options */
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
  if (hasApprovals && !autoApprove && approvals) {
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

/** 计划模式且计划未批准时,拦住需审批的写操作并提示先用只读工具研究再提交计划。 @param {PlanBlockOptions} options */
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

/** 向用户申请单次工具审批:命中自动批准/计划授权则放行,否则等待用户决定(可记会话级)。 @param {ToolApprovalOptions} options */
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
  if (!needsApproval || !hasApprovals || !approvals || sessionApproved.has(name)) return false;
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
