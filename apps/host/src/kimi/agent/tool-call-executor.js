// @ts-check
import {
  blockUntilPlanApproved,
  handleExitPlanMode,
  requestToolApproval,
  runPreToolHook,
  toolNeedsApproval,
} from './approval-gate.js';
import { validateToolArguments } from './arg-validator.js';
import { parseToolCall } from './tool-loop-support.js';
import { traceToolResult } from './run-trace-events.js';

/**
 * @typedef {Record<string, unknown>} ToolArgs
 * @typedef {{ id?: unknown, function?: { name?: string, arguments?: string } }} ToolCall
 * @typedef {{ name: string, description?: string, mutating?: boolean, risk?: string, parameters?: unknown, handler?: (args?: ToolArgs, context?: Record<string, unknown>) => unknown | Promise<unknown> }} AgentTool
 * @typedef {{ formatToolResult(result: unknown, context: { toolName: string }): { content: string, summarized?: boolean, beforeTokens?: unknown, afterTokens?: unknown, sources?: unknown[], injectionFlagged?: boolean, injectionReasons?: unknown[] } }} ContextManager
 * @typedef {{ run(operation: () => unknown | Promise<unknown>): Promise<unknown>, lastRun: { retried?: boolean, attempts?: unknown, errors?: unknown } }} RetryPolicy
 * @typedef {{ check(): { shouldAbort?: boolean } & Record<string, unknown> }} BudgetGuard
 * @typedef {{ observe(call: { name: string, args: ToolArgs }, ok: boolean): { shouldBreak?: boolean, reason?: unknown, repeatCount?: unknown, consecutiveFailures?: unknown } }} LoopGuard
 * @typedef {{ start(name: string): { finish(status: string): void } }} TodoTracker
 * @typedef {(kind: string, extra?: Record<string, unknown>) => void} AuditFn
 * @typedef {(type: string, payload: Record<string, unknown>) => void} EmitFn
 * @typedef {{ saveCheckpoint(phase: string, step: number): void, stopOnBudget(decision: Record<string, unknown>): void }} ExecutorCallbacks
 * @typedef {{ call: ToolCall, stepNumber: number, toolMap: Map<string, AgentTool>, activeContextManager: ContextManager, activeRetryPolicy: RetryPolicy, activeBudgetGuard: BudgetGuard, activeLoopGuard: LoopGuard, toolCtx: Record<string, unknown>, toolTodos: TodoTracker, hasApprovals: boolean, autoApprove: boolean, approvals?: import('./approval-gate.js').ApprovalRegistry | null, sessionApproved: Set<string>, runId?: unknown, planMode: boolean, planApproved: boolean, hooks?: import('./approval-gate.js').HookEngine | null, audit: AuditFn, emit: EmitFn, messages: Array<Record<string, unknown>>, steps: Array<Record<string, unknown>>, context?: import('./approval-gate.js').RequestContext, runTrace?: import('./run-trace-events.js').RunTraceLike | null, callbacks: ExecutorCallbacks }} ExecuteToolCallOptions
 * @typedef {{ planApproved?: boolean, didMutate?: boolean, stopForBudget?: boolean, stopForLoopGuard?: boolean, breakToolLoop?: boolean }} ExecuteToolCallResult
 */

/** @param {unknown} result */
function hasError(result) {
  return !!(result && typeof result === 'object' && 'error' in result && /** @type {{ error?: unknown }} */ (result).error);
}

/** @param {unknown} result */
function resultPath(result) {
  if (!result || typeof result !== 'object' || !('path' in result)) return '';
  return String(/** @type {{ path?: unknown }} */ (result).path || '');
}

/** @param {ExecuteToolCallOptions} options @returns {Promise<ExecuteToolCallResult>} */
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
  callbacks,
}) {
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
  if (await runPreToolHook({ hooks, name: toolName, args, steps, audit, emit, messages, call })) {
    callbacks.saveCheckpoint('tool_result', stepNumber);
    return {};
  }

  const planResult = await handleExitPlanMode({
    name: toolName, args, hasApprovals, autoApprove, approvals, runId, emit, audit, steps, messages, call, context,
  });
  if (planResult.handled) {
    callbacks.saveCheckpoint('plan_result', stepNumber);
    return { planApproved: !!planResult.planApproved };
  }

  if (blockUntilPlanApproved({ planMode, planApproved, needsApproval, name: toolName, tool, steps, audit, emit, messages, call })) {
    callbacks.saveCheckpoint('tool_result', stepNumber);
    return {};
  }

  if (tool && await requestToolApproval({
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
  })) {
    callbacks.saveCheckpoint('approval_result', stepNumber);
    return {};
  }

  const todo = toolTodos.start(toolName);
  const toolStartedAt = Date.now();
  let result;
  try {
    result = await activeRetryPolicy.run(async () => (
      tool && typeof tool.handler === 'function' ? tool.handler(args, toolCtx) : { error: `unknown tool: ${toolName}` }
    ));
  } catch (err) {
    const error = /** @type {{ message?: unknown }} */ (err && typeof err === 'object' ? err : {});
    result = { error: error.message };
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
