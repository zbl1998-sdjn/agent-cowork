// 审批门禁的上下文与统一失败结果(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:构造租户/用户审批作用域，并把审批服务不可用统一记录为 fail-closed 结果。
// 依赖:无；仅接受 approval-gate 注入的结构化回调，避免接触执行器或基础设施层。

type BlockTarget = {
  name: string;
  steps: Array<Record<string, unknown>>;
  audit: (kind: string, extra?: Record<string, unknown>) => void;
  emit: (type: string, payload: Record<string, unknown>) => void;
  messages: Array<Record<string, unknown>>;
  call: { id?: unknown };
};

export function approvalScope(context: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(context.tenantId ? { tenantId: context.tenantId } : {}),
    ...(context.userId ? { userId: context.userId } : {}),
  };
}

export function recordUnavailableApproval(
  target: BlockTarget,
  error: string,
  auditKind: string,
  auditDetails: Record<string, unknown>,
): void {
  const result = { error, code: 'APPROVAL_REQUIRED' };
  target.steps.push({ tool: target.name, ok: false, approvalUnavailable: true });
  target.audit(auditKind, auditDetails);
  target.emit('tool_result', { name: target.name, status: 'blocked', result });
  target.messages.push({ role: 'tool', tool_call_id: target.call.id, content: JSON.stringify(result) });
}
