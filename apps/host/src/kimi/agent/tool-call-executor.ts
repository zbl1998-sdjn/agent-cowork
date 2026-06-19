// 单次工具调用的执行管线(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:把一次工具调用从头跑到尾——解析参数→schema 校验→pre_tool hook→计划/审批门禁
//      →带重试执行→记录用量/审计/trace/todo→格式化结果写回 messages→post_tool hook
//      →预算与循环看护检查;并通过返回值告知主循环是否需要中断/已发生变更。
// 依赖:同层 approval-gate / arg-validator / tool-loop-support / run-trace-events;
//      其余能力(重试、上下文、预算、看护、checkpoint)由调用方注入。
// 导出:executeToolCall(返回 { planApproved?, didMutate?, stop*?, breakToolLoop? })
import {
  blockUntilPlanApproved,
  handleExitPlanMode,
  requestToolApproval,
  runPreToolHook,
  toolNeedsApproval,
} from './approval-gate.js';
import { validateToolArguments } from './arg-validator.js';
import { traceToolResult, type RunTraceLike } from './run-trace-events.js';
import { parseToolCall } from './tool-loop-support.js';
import { omitUndefined } from '../../util/object.js';
import type { ApprovalRegistry, HookEngine, RequestContext } from './approval-gate.js';

export type ToolArgs = Record<string, unknown>;
export type ToolCall = { id?: unknown; function?: { name?: string; arguments?: string } };
export type AgentTool = { name: string; description?: string; mutating?: boolean; risk?: string; requiresApproval?: boolean; parameters?: unknown; handler?: (args?: ToolArgs, context?: Record<string, unknown>) => unknown | Promise<unknown> };
export type FormattedToolResult = { content: string; summarized?: boolean; beforeTokens?: unknown; afterTokens?: unknown; sources?: unknown[]; injectionFlagged?: boolean; injectionReasons?: unknown[] };
export type ContextManager = { formatToolResult(result: unknown, context: { toolName: string }): FormattedToolResult };
export type RetryPolicy = {
  run<T>(operation: () => Promise<T> | T): Promise<T>;
  lastRun: { retried?: boolean; attempts?: unknown; errors?: unknown };
};
export type BudgetGuard = { check(): { shouldAbort?: boolean } & Record<string, unknown> };
export type LoopGuard = {
  observe(call: { name: string; args: ToolArgs }, ok: boolean): {
    shouldBreak?: boolean;
    reason?: unknown;
    repeatCount?: unknown;
    consecutiveFailures?: unknown;
  };
};
export type TodoTracker = { start(name: string): { finish(status: string): void } };
export type AuditFn = (kind: string, extra?: Record<string, unknown>) => void;
export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
export type ExecutorCallbacks = { saveCheckpoint(phase: string, step: number): void; stopOnBudget(decision: Record<string, unknown>): void };
export type ExecuteToolCallOptions = {
  call: ToolCall;
  stepNumber: number;
  toolMap: Map<string, AgentTool>;
  activeContextManager: ContextManager;
  activeRetryPolicy: RetryPolicy;
  activeBudgetGuard: BudgetGuard;
  activeLoopGuard: LoopGuard;
  toolCtx: Record<string, unknown>;
  toolTodos: TodoTracker;
  hasApprovals: boolean;
  autoApprove: boolean;
  approvals?: ApprovalRegistry | null;
  sessionApproved: Set<string>;
  runId?: unknown;
  planMode: boolean;
  planApproved: boolean;
  hooks?: HookEngine | null;
  audit: AuditFn;
  emit: EmitFn;
  messages: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
  context?: RequestContext;
  runTrace?: RunTraceLike | null;
  signal?: AbortSignal | null;
  callbacks: ExecutorCallbacks;
};
export type ExecuteToolCallResult = { planApproved?: boolean; didMutate?: boolean; stopForBudget?: boolean; stopForLoopGuard?: boolean; breakToolLoop?: boolean };

function hasError(result: unknown): boolean {
  return !!(result && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error);
}

function resultPath(result: unknown): string {
  if (!result || typeof result !== 'object' || !('path' in result)) return '';
  return String((result as { path?: unknown }).path || '');
}

/** 执行一次工具调用的完整管线:校验→门禁→重试执行→记账/写回结果→预算与循环看护。 */
export async function executeToolCall({
  call,
  stepNumber,
  toolMap,
  activeContextManager,
  activeRetryPolicy,
  activeBudgetGuard,
  activeLoopGuard,
  toolCtx,
  toolTodos,
  hasApprovals,
  autoApprove,
  approvals,
  sessionApproved,
  runId,
  planMode,
  planApproved,
  hooks,
  audit,
  emit,
  messages,
  steps,
  context,
  runTrace,
  signal,
  callbacks,
}: ExecuteToolCallOptions): Promise<ExecuteToolCallResult> {
  const { name, args } = parseToolCall(call);
  const toolName = String(name || '');
  emit('tool_call', { name: toolName, args });
  const tool = toolMap.get(toolName);
  const argValidation = tool ? validateToolArguments(tool.parameters, args) : { valid: true, errors: [] };
  if (!argValidation.valid) {
    const result = { error: 'invalid tool arguments', errors: argValidation.errors };
    steps.push({ tool: toolName, ok: false, invalidArgs: true });
    audit('tool.args_invalid', { tool: toolName, errors: argValidation.errors });
    emit('tool_args_invalid', { name: toolName, errors: argValidation.errors });
    emit('tool_result', { name: toolName, status: 'failed', result });
    traceToolResult(runTrace, stepNumber, call, toolName, 'failed', result);
    const formatted = activeContextManager.formatToolResult(result, { toolName });
    messages.push({ role: 'tool', tool_call_id: call.id, content: formatted.content });
    callbacks.saveCheckpoint('tool_result', stepNumber);
    return {};
  }

  const isMutating = !!(tool && tool.mutating === true);
  const needsApproval = toolNeedsApproval(tool);
  if (await runPreToolHook(omitUndefined({ hooks, name: toolName, args, steps, audit, emit, messages, call }))) {
    callbacks.saveCheckpoint('tool_result', stepNumber);
    return {};
  }

  const planResult = await handleExitPlanMode(omitUndefined({
    name: toolName,
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
  }));
  if (planResult.handled) {
    callbacks.saveCheckpoint('plan_result', stepNumber);
    return { planApproved: !!planResult.planApproved };
  }

  if (blockUntilPlanApproved(omitUndefined({ planMode, planApproved, needsApproval, name: toolName, tool, steps, audit, emit, messages, call }))) {
    callbacks.saveCheckpoint('tool_result', stepNumber);
    return {};
  }

  if (tool && await requestToolApproval(omitUndefined({
    needsApproval,
    hasApprovals,
    sessionApproved,
    name: toolName,
    args,
    tool,
    runId,
    approvals,
    emit,
    audit,
    messages,
    call,
    autoApprove,
    planMode,
    planApproved,
    steps,
    context,
  }))) {
    callbacks.saveCheckpoint('approval_result', stepNumber);
    return {};
  }

  const todo = toolTodos.start(toolName);
  const toolStartedAt = Date.now();
  let result: unknown;
  try {
    // 把取消/超时信号并入工具上下文,让支持中断的工具(沙箱/MCP/网络)在"停止"后真正止损。
    const handlerCtx = signal ? { ...toolCtx, signal } : toolCtx;
    result = await activeRetryPolicy.run(async () => (
      tool && typeof tool.handler === 'function' ? tool.handler(args, handlerCtx) : { error: `unknown tool: ${toolName}` }
    ));
  } catch (err) {
    const error = err && typeof err === 'object' ? err as { message?: unknown } : {};
    const message = typeof error.message === 'string' && error.message
      ? error.message
      : typeof err === 'string' && err
        ? err
        : 'tool handler failed';
    result = { error: message };
  }
  const durationMs = Math.max(0, Date.now() - toolStartedAt);
  if (activeRetryPolicy.lastRun.retried) {
    emit('tool_retry', {
      name: toolName,
      attempts: activeRetryPolicy.lastRun.attempts,
      errors: activeRetryPolicy.lastRun.errors,
    });
  }
  const ok = !hasError(result);
  // 仅当"需审批的工具成功执行"才算发生真实变更——据此决定收尾是否触发 verify 复核。
  const didMutate = !!(ok && needsApproval);
  const path = resultPath(result);
  if (ok && isMutating && path) emit('file_written', { path });
  steps.push({ tool: toolName, ok, durationMs });
  if (needsApproval) audit('tool.execute', { tool: toolName, risk: tool ? tool.risk : undefined, ok });
  todo.finish(ok ? 'done' : 'failed');
  emit('tool_result', { name: toolName, status: ok ? 'succeeded' : 'failed', result, durationMs });
  traceToolResult(runTrace, stepNumber, call, toolName, ok ? 'succeeded' : 'failed', result);
  const formatted = activeContextManager.formatToolResult(result, { toolName });
  if (formatted.summarized) {
    emit('tool_result_summary', {
      name: toolName,
      beforeTokens: formatted.beforeTokens,
      afterTokens: formatted.afterTokens,
      sources: formatted.sources || [],
    });
  }
  if (formatted.injectionFlagged) {
    emit('untrusted_content_flagged', {
      name: toolName,
      reasons: formatted.injectionReasons || [],
    });
  }
  messages.push({ role: 'tool', tool_call_id: call.id, content: formatted.content });
  callbacks.saveCheckpoint('tool_result', stepNumber);
  if (hooks) await hooks.run('post_tool', { name: toolName, result, ok });
  const postToolBudgetDecision = activeBudgetGuard.check();
  if (postToolBudgetDecision.shouldAbort) {
    callbacks.stopOnBudget(postToolBudgetDecision);
    return { didMutate, stopForBudget: true, breakToolLoop: true };
  }
  const guardDecision = activeLoopGuard.observe({ name: toolName, args }, ok);
  if (guardDecision.shouldBreak) {
    emit('loop_guard_break', {
      name: toolName,
      reason: guardDecision.reason,
      repeatCount: guardDecision.repeatCount,
      consecutiveFailures: guardDecision.consecutiveFailures,
    });
    messages.push({ role: 'user', content: `循环护栏已停止当前路径：${guardDecision.reason}` });
    return { didMutate, stopForLoopGuard: true, breakToolLoop: true };
  }
  return { didMutate };
}
