// Agent 主循环编排(runAgentChat)(host · L1 领域层 · kimi/agent)
// ---------------------------------------------------------------------------
// 职责:本子目录的总装入口——拼系统提示与工具集、按步预算循环调用模型,把每个工具调用
//      交给 executeToolCall,期间穿插上下文压缩、检查点、超时/预算/循环看护与收尾兜底;
//      无工具调用即收尾(可选 verify 复核),返回 { text, steps, usage, ... }。
// 依赖:聚合本子目录各模块(approval-gate/finalize/clarification/model-resilience/
//      todo-state/loop-guard/tool-retry/run-timeout/checkpoint-state/run-trace-events/
//      tool-loop-support/tool-call-executor)及同层 agent-tools/system-prompt/context 等。
// 导出:runAgentChat
import { createAgentTools } from '../agent-tools.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { resolveAgentEnvFacts } from '../agent-env.js';
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
import { omitUndefined } from '../../util/object.js';
import type { AskTool } from './clarification.js';
import type { AgentTool } from './tool-call-executor.js';
import type { BudgetDecision, ChatMessage, ContextManagerLike, ModelMessage, RunAgentChatOptions, RunAgentChatResult } from './tool-loop-types.js';

export type {
  BudgetDecision,
  BudgetGuardLike,
  ChatMessage,
  ContextManagerLike,
  ContextPrepareResult,
  EmitFn,
  ModelConfig,
  ModelMessage,
  ResumeState,
  RunAgentChatOptions,
  RunAgentChatResult,
} from './tool-loop-types.js';

/** Agent 主循环:装配工具与上下文,按步调用模型并执行工具调用,直至收尾或被各类守卫叫停。 */
export async function runAgentChat(options: RunAgentChatOptions): Promise<RunAgentChatResult> {
  const { prompt, kimiConfig, trustedRoot, tools, modelCall = defaultAgentModelCall, maxSteps = 6, approvals = null, autoApprove = false, planMode = false, developerMode = false, auditBus = null, hooks = null, memoryText = '', skills = [], emit = () => undefined, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context = {}, fetchImpl, lazyTools = [], verify = false, maxVerifySteps = 3, signal = null, runId = null, userContent = null, clarifyBeforeModel = false, contextManager = null, contextOptions = {}, loopGuard = null, loopGuardOptions = {}, retryPolicy = null, retryOptions = {}, budgetGuard = null, runTimeoutMs = 0, checkpointer = null, resumeState = null, runTrace = null } = options;
  const agentTools = (tools
    || createAgentTools({ trustedRoot, sandbox, sandboxLimits, context } as Parameters<typeof createAgentTools>[0]) as AgentTool[]).slice();
  ensureExitPlanModeTool(agentTools, planMode);
  const toolMap = addLazySearchTool(agentTools, lazyTools);
  const buildToolSpecs = () => agentTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolCtx = { trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context };
  const clarified = clarifyBeforeModel
    ? await clarifyPromptBeforeModel({ prompt, userContent, toolMap: toolMap as unknown as Map<string, AskTool> })
    : { prompt, clarified: false };
  const userMessage = (Array.isArray(userContent) && userContent.length)
    ? { role: 'user', content: userContent }
    : { role: 'user', content: clarified.prompt };
  const activeContextManager = (contextManager || createContextManager(contextOptions as Parameters<typeof createContextManager>[0])) as ContextManagerLike;
  const activeLoopGuard = loopGuard || createLoopGuard(loopGuardOptions as Parameters<typeof createLoopGuard>[0]);
  const activeRetryPolicy = retryPolicy || createRetryPolicy(retryOptions as Parameters<typeof createRetryPolicy>[0]);
  const activeBudgetGuard = budgetGuard || createNoopBudgetGuard();
  const resumed = resumeState;
  const resumeUsage = (resumed && resumed.usage) || {};
  const envFacts = resolveAgentEnvFacts({ trustedRoot, kimiConfig });
  const defaultMessages: ChatMessage[] = [{ role: 'system', content: buildSystemPrompt({ memoryText, skills, planMode, developerMode, env: envFacts }) }, userMessage];
  let messages = (resumed && Array.isArray(resumed.messages) && resumed.messages.length) ? resumed.messages : defaultMessages;
  const steps: Array<Record<string, unknown>> = [];
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

  // 开启 verify 时额外预留若干步给"读回改动核对"阶段,避免复核挤占正常任务步数。
  const stepBudget = maxSteps + (verify ? Math.max(0, maxVerifySteps) : 0);
  const runTimeout = createRunTimeout({ signal, timeoutMs: runTimeoutMs });
  let stopForLoopGuard = false;
  let stopForBudget = false;
  let stopForTimeout = false;
  let lastCheckpointStep = 0;
  const saveCheckpoint = (phase: string, step: number, checkpointMessages: unknown = messages) => {
    if (checkpointRecorder.save(phase, step, checkpointMessages)) lastCheckpointStep = step;
  };
  const stopOnBudget = (budgetDecision: BudgetDecision) => {
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
      const onContent = (d: unknown) => { streamedContent = true; if (d) emit('token', { delta: d }); };
      const onReasoning = (d: unknown) => { streamedReasoning = true; if (d) emit('reasoning', { delta: d }); };
      let message;
      try {
        const modelTimeoutMs = typeof kimiConfig?.timeoutMs === 'number' ? kimiConfig.timeoutMs : undefined;
        message = await callModelResilient(modelCall, {
          messages,
          tools: toolSpecs,
          kimiConfig,
          fetchImpl,
          signal: runTimeout.signal,
          onContent,
          onReasoning,
        }, omitUndefined({
          kimiConfig,
          timeoutMs: modelTimeoutMs,
          onFallback: (event: { failed: unknown; next: unknown; error: string }) => emit('model_fallback', event),
        })) as ModelMessage;
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
        // 发生过真实写改且尚未复核时,先不收尾:塞一条只读核对指令再跑一轮,确认改动无误。
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

    finalText = (await summarizeAfterBudget(omitUndefined({ finalText, signal: runTimeout.signal, messages, modelCall, kimiConfig, fetchImpl, emit, usageTotals }))) || '';
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
