// @ts-check
import { createAgentTools } from '../agent-tools.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { defaultAgentModelCall } from '../model-call.js';
import { ensureExitPlanModeTool, makeAudit } from './approval-gate.js';
import {
  addUsage,
  applyStaticBackstop,
  summarizeAfterBudget,
} from './finalize.js';
import { clarifyPromptBeforeModel } from './clarification.js';
import { callModelResilient } from './model-resilience.js';
import { createToolTodoTracker } from './todo-state.js';
import { createLoopGuard } from './loop-guard.js';
import { createRetryPolicy } from './tool-retry.js';
import { createContextManager } from '../context/context-manager.js';
import { createRunTimeout, isAbortLikeError } from './run-timeout.js';
import { createCheckpointRecorder } from './checkpoint-state.js';
import { traceModelContext, traceToolDecision } from './run-trace-events.js';
import { addLazySearchTool, createNoopBudgetGuard } from './tool-loop-support.js';
import { executeToolCall } from './tool-call-executor.js';

/**
 * @typedef {import('./tool-call-executor.js').AgentTool} AgentTool
 * @typedef {import('./tool-call-executor.js').ToolCall} ToolCall
 * @typedef {Record<string, unknown> & { timeoutMs?: number }} ModelConfig
 * @typedef {{ prompt_tokens?: unknown, completion_tokens?: unknown, total_tokens?: unknown }} Usage
 * @typedef {{ role: string, content: unknown, [key: string]: unknown }} ChatMessage
 * @typedef {{ content?: string, reasoning_content?: string, tool_calls?: ToolCall[], usage?: Usage }} ModelMessage
 * @typedef {(type: string, payload: unknown) => void} EmitFn
 * @typedef {{ shouldAbort?: boolean, limit?: unknown, actual?: unknown, maximum?: unknown, reason?: unknown, snapshot?: unknown }} BudgetDecision
 * @typedef {{ check(): BudgetDecision, recordUsage(usage?: Usage): BudgetDecision, stopMessage(decision: BudgetDecision): string }} BudgetGuardLike
 * @typedef {{ prepareMessages(messages: ChatMessage[]): { messages?: ChatMessage[], compacted?: boolean, beforeTokens?: unknown, afterTokens?: unknown, keyFacts?: unknown[] }, formatToolResult(result: unknown, context: { toolName: string }): { content: string, summarized?: boolean, beforeTokens?: unknown, afterTokens?: unknown, sources?: unknown[], injectionFlagged?: boolean, injectionReasons?: unknown[] } }} ContextManagerLike
 * @typedef {{ usage?: Usage, messages?: ChatMessage[], approvedTools?: string[], todos?: unknown[] }} ResumeState
 * @typedef {{ prompt?: unknown, kimiConfig?: ModelConfig, trustedRoot: string, tools?: AgentTool[], modelCall?: import('./model-resilience.js').ModelCall, maxSteps?: number, approvals?: import('./approval-gate.js').ApprovalRegistry | null, autoApprove?: boolean, planMode?: boolean, developerMode?: boolean, auditBus?: import('./approval-gate.js').AuditBus | null, hooks?: import('./approval-gate.js').HookEngine | null, memoryText?: string, skills?: import('../system-prompt.js').SkillDescriptor[], emit?: EmitFn, sandbox?: import('../agent-tools.js').SandboxLike, sandboxLimits?: import('../agent-tools.js').SandboxLimits, runStoreRoot?: unknown, runEvents?: unknown, runsIndex?: unknown, context?: import('./approval-gate.js').RequestContext, fetchImpl?: unknown, lazyTools?: AgentTool[], verify?: boolean, maxVerifySteps?: number, signal?: AbortSignal | null, runId?: string | null, userContent?: unknown, clarifyBeforeModel?: boolean, contextManager?: ContextManagerLike | null, contextOptions?: unknown, loopGuard?: import('./tool-call-executor.js').LoopGuard | null, loopGuardOptions?: unknown, retryPolicy?: import('./tool-call-executor.js').RetryPolicy | null, retryOptions?: unknown, budgetGuard?: BudgetGuardLike | null, runTimeoutMs?: number, checkpointer?: import('./checkpoint-state.js').Checkpointer | null, resumeState?: ResumeState | null, runTrace?: import('./run-trace-events.js').RunTraceLike | null }} RunAgentChatOptions
 */

/** @param {RunAgentChatOptions} options */
export async function runAgentChat(options) {
  const { prompt, kimiConfig, trustedRoot, tools, modelCall = defaultAgentModelCall, maxSteps = 6, approvals = null, autoApprove = false, planMode = false, developerMode = false, auditBus = null, hooks = null, memoryText = '', skills = [], emit = () => {}, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context = {}, fetchImpl, lazyTools = [], verify = false, maxVerifySteps = 3, signal = null, runId = null, userContent = null, clarifyBeforeModel = false, contextManager = null, contextOptions = {}, loopGuard = null, loopGuardOptions = {}, retryPolicy = null, retryOptions = {}, budgetGuard = null, runTimeoutMs = 0, checkpointer = null, resumeState = null, runTrace = null } = options;
  /** @type {AgentTool[]} */
  const agentTools = (tools
    || createAgentTools({ trustedRoot, sandbox, sandboxLimits, context })).slice();
  ensureExitPlanModeTool(agentTools, planMode);
  const toolMap = addLazySearchTool(agentTools, lazyTools);
  const buildToolSpecs = () => agentTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolCtx = { trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context };
  const clarified = clarifyBeforeModel
    ? await clarifyPromptBeforeModel({ prompt, userContent, toolMap: /** @type {Map<string, import('./clarification.js').AskTool>} */ (/** @type {unknown} */ (toolMap)) })
    : { prompt, clarified: false };
  const userMessage = (Array.isArray(userContent) && userContent.length)
    ? { role: 'user', content: userContent }
    : { role: 'user', content: clarified.prompt };
  /** @type {ContextManagerLike} */
  const activeContextManager = /** @type {ContextManagerLike} */ (contextManager || createContextManager(/** @type {ConstructorParameters<typeof import('../context/context-manager.js').ContextManager>[0]} */ (contextOptions)));
  const activeLoopGuard = loopGuard || createLoopGuard(/** @type {ConstructorParameters<typeof import('./loop-guard.js').LoopGuard>[0]} */ (loopGuardOptions));
  const activeRetryPolicy = retryPolicy || createRetryPolicy(/** @type {ConstructorParameters<typeof import('./tool-retry.js').RetryPolicy>[0]} */ (retryOptions));
  /** @type {BudgetGuardLike} */
  const activeBudgetGuard = budgetGuard || createNoopBudgetGuard();
  const resumed = resumeState;
  const resumeUsage = (resumed && resumed.usage) || {};
  const defaultMessages = [{ role: 'system', content: buildSystemPrompt({ memoryText, skills, planMode, developerMode }) }, userMessage];
  /** @type {ChatMessage[]} */
  let messages = (resumed && Array.isArray(resumed.messages) && resumed.messages.length) ? resumed.messages : defaultMessages;
  /** @type {Array<Record<string, unknown>>} */
  const steps = [];
  const sessionApproved = new Set((resumed && Array.isArray(resumed.approvedTools)) ? resumed.approvedTools : []);
  const hasApprovals = !!approvals;
  const usageTotals = { prompt_tokens: Number(resumeUsage.prompt_tokens || 0), completion_tokens: Number(resumeUsage.completion_tokens || 0), total_tokens: Number(resumeUsage.total_tokens || 0) };
  const audit = makeAudit(auditBus, context);
  let finalText = '';
  let planApproved = !planMode;
  let didMutate = false;
  let verified = false;
  const checkpointRecorder = createCheckpointRecorder({
    checkpointer,
    runId,
    usageTotals,
    sessionApproved,
    steps,
    context,
    initialTodos: resumed ? resumed.todos : [],
    getFinalText: () => finalText,
    emit,
  });
  const toolTodos = createToolTodoTracker(checkpointRecorder.emitTodo);

  const stepBudget = maxSteps + (verify ? Math.max(0, maxVerifySteps) : 0);
  const runTimeout = createRunTimeout({ signal, timeoutMs: runTimeoutMs });
  let stopForLoopGuard = false;
  let stopForBudget = false;
  let stopForTimeout = false;
  let lastCheckpointStep = 0;
  /** @param {string} phase @param {number} step @param {Array<Record<string, unknown>>} [checkpointMessages] */
  const saveCheckpoint = (phase, step, checkpointMessages = messages) => {
    if (checkpointRecorder.save(phase, step, checkpointMessages)) lastCheckpointStep = step;
  };
  /** @param {BudgetDecision} budgetDecision */
  const stopOnBudget = (budgetDecision) => {
    stopForBudget = true;
    const text = activeBudgetGuard.stopMessage(budgetDecision);
    finalText = text;
    emit('budget_guard_abort', {
      limit: budgetDecision.limit,
      actual: budgetDecision.actual,
      maximum: budgetDecision.maximum,
      reason: budgetDecision.reason,
      snapshot: budgetDecision.snapshot,
    });
    emit('token', { delta: text });
  };
  const stopOnTimeout = () => {
    stopForTimeout = true;
    finalText = runTimeout.stopMessage();
    emit('run_timeout', { timeoutMs: runTimeout.timeoutMs });
    emit('token', { delta: finalText });
  };
  try {
    for (let i = 0; i < stepBudget; i += 1) {
    if (runTimeout.aborted()) break;
    if (stopForLoopGuard) break;
    if (stopForBudget) break;
    const preBudgetDecision = activeBudgetGuard.check();
    if (preBudgetDecision.shouldAbort) {
      stopOnBudget(preBudgetDecision);
      break;
    }
    const stepNumber = i + 1;
    let streamedContent = false;
    let streamedReasoning = false;
    const prepared = activeContextManager.prepareMessages(messages);
    if (Array.isArray(prepared.messages)) {
      messages = prepared.messages;
      if (prepared.compacted) {
        emit('context_compacted', {
          beforeTokens: prepared.beforeTokens,
          afterTokens: prepared.afterTokens,
          keyFacts: prepared.keyFacts || [],
        });
      }
    }
    const toolSpecs = buildToolSpecs();
    traceModelContext(runTrace, stepNumber, messages, toolSpecs);
    /** @param {unknown} d */
    const onContent = (d) => { streamedContent = true; if (d) emit('token', { delta: d }); };
    /** @param {unknown} d */
    const onReasoning = (d) => { streamedReasoning = true; if (d) emit('reasoning', { delta: d }); };
    /** @type {ModelMessage} */
    let message;
    try {
      message = /** @type {ModelMessage} */ (await callModelResilient(modelCall, {
        messages,
        tools: toolSpecs,
        kimiConfig,
        fetchImpl,
        signal: runTimeout.signal,
        onContent,
        onReasoning,
      }, { kimiConfig, timeoutMs: kimiConfig?.timeoutMs, onFallback: (event) => emit('model_fallback', event) }));
    } catch (err) {
      if (runTimeout.aborted() && isAbortLikeError(err)) {
        if (runTimeout.timedOut()) stopOnTimeout();
        break;
      }
      throw err;
    }
    if (!streamedReasoning && message.reasoning_content) emit('reasoning', { delta: message.reasoning_content });
    addUsage(usageTotals, message.usage);
    const usageBudgetDecision = activeBudgetGuard.recordUsage(message.usage);
    if (usageBudgetDecision.shouldAbort) {
      stopOnBudget(usageBudgetDecision);
      break;
    }
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      finalText = message.content || '';
      const finalMessage = { role: 'assistant', content: finalText };
      if (verify && didMutate && !verified) {
        verified = true;
        emit('verify_start', {});
        audit('verify.start', {});
        messages.push(finalMessage);
        messages.push({ role: 'user', content: '请用只读工具(Read/Glob/Grep)读回你刚才改动或新建的文件，核对内容是否正确、完整。如发现问题请修正；确认无误后用一句话中文总结结果。' });
        saveCheckpoint('verify_requested', stepNumber);
        continue;
      }
      saveCheckpoint('completed', stepNumber, [...messages, finalMessage]);
      if (!streamedContent && finalText) emit('token', { delta: finalText });
      break;
    }

    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) });
    traceToolDecision(runTrace, stepNumber, message);
    saveCheckpoint('assistant_tool_calls', stepNumber);
    for (const call of calls) {
      const result = await executeToolCall({
        call, stepNumber, toolMap, activeContextManager, activeRetryPolicy,
        activeBudgetGuard, activeLoopGuard, toolCtx, toolTodos,
        hasApprovals, autoApprove, approvals, sessionApproved, runId,
        planMode, planApproved, hooks, audit, emit, messages, steps, context, runTrace,
        callbacks: { saveCheckpoint, stopOnBudget },
      });
      if (result.planApproved) planApproved = true;
      if (result.didMutate) didMutate = true;
      if (result.stopForBudget) stopForBudget = true;
      if (result.stopForLoopGuard) stopForLoopGuard = true;
      if (result.breakToolLoop) break;
    }
  }

    finalText = (await summarizeAfterBudget({ finalText, signal: runTimeout.signal, messages, modelCall, kimiConfig, fetchImpl, emit, usageTotals })) || '';
    finalText = applyStaticBackstop(finalText, runTimeout.signal, emit);
    if ((stopForBudget || stopForTimeout || stopForLoopGuard) && finalText) {
      const phase = stopForBudget ? 'budget_stopped' : (stopForTimeout ? 'timeout_stopped' : 'loop_guard_stopped');
      saveCheckpoint(phase, lastCheckpointStep || stepBudget, [...messages, { role: 'assistant', content: finalText }]);
    }
    return {
      text: finalText,
      steps,
      usage: usageTotals,
      cancelled: !!(signal && signal.aborted),
      budgetStopped: stopForBudget,
      timeoutStopped: stopForTimeout,
    };
  } finally {
    runTimeout.dispose();
  }
}
