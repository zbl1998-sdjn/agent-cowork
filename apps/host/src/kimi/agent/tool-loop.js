import { createAgentTools } from '../agent-tools.js';
import { buildSystemPrompt } from '../system-prompt.js';
import { defaultAgentModelCall } from '../model-call.js';
import {
  blockUntilPlanApproved,
  ensureExitPlanModeTool,
  handleExitPlanMode,
  makeAudit,
  requestToolApproval,
  runPreToolHook,
  toolNeedsApproval,
} from './approval-gate.js';
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
import { validateToolArguments } from './arg-validator.js';
import { createContextManager } from '../context/context-manager.js';
import { createRunTimeout, isAbortLikeError } from './run-timeout.js';
import { createCheckpointRecorder } from './checkpoint-state.js';
import { traceModelContext, traceToolDecision, traceToolResult } from './run-trace-events.js';

function addLazySearchTool(agentTools, lazyTools) {
  const activeNames = new Set(agentTools.map((t) => t.name));
  const toolMap = new Map(agentTools.map((t) => [t.name, t]));
  if (!Array.isArray(lazyTools) || !lazyTools.length) return toolMap;
  const searchTool = {
    name: 'search_tools',
    risk: 'safe',
    mutating: false,
    description: '按关键词检索可用的扩展工具(如外部连接器/MCP)。返回匹配工具的名称与描述;被检索到的工具随后即可直接调用。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    handler: async ({ query = '', limit = 5 } = {}) => {
      const terms = String(query).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
      const ranked = lazyTools
        .filter((t) => !activeNames.has(t.name))
        .map((t) => {
          const hay = `${t.name} ${t.description || ''}`.toLowerCase();
          return { t, score: terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) };
        })
        .filter((r) => terms.length === 0 || r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
      for (const { t } of ranked) {
        agentTools.push(t);
        toolMap.set(t.name, t);
        activeNames.add(t.name);
      }
      return { activated: ranked.map(({ t }) => ({ name: t.name, description: t.description || '' })) };
    },
  };
  agentTools.push(searchTool);
  toolMap.set(searchTool.name, searchTool);
  return toolMap;
}

function parseToolCall(call) {
  const name = call.function && call.function.name;
  try {
    return { name, args: JSON.parse((call.function && call.function.arguments) || '{}') };
  } catch {
    return { name, args: {} };
  }
}

function createNoopBudgetGuard() {
  const snapshot = {
    runUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    sessionUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    runCostUsd: 0,
    sessionCostUsd: 0,
    elapsedMs: 0,
    model: 'default',
  };
  const ok = { shouldAbort: false, limit: '', actual: 0, maximum: 0, reason: '', snapshot };
  return {
    check: () => ok,
    recordUsage: () => ok,
    stopMessage: () => '本轮已触发预算保护，已安全停止继续执行。',
  };
}

export async function runAgentChat({
  prompt,
  kimiConfig,
  trustedRoot,
  tools,
  modelCall = defaultAgentModelCall,
  maxSteps = 6,
  approvals = null,
  autoApprove = false,
  planMode = false,
  developerMode = false,
  auditBus = null,
  hooks = null,
  memoryText = '',
  skills = [],
  emit = () => {},
  sandbox,
  sandboxLimits,
  runStoreRoot,
  runEvents,
  runsIndex,
  context = {},
  fetchImpl,
  lazyTools = [],
  verify = false,
  maxVerifySteps = 3,
  signal = null,
  runId = null,
  userContent = null,
  clarifyBeforeModel = false,
  contextManager = null,
  contextOptions = {},
  loopGuard = null,
  loopGuardOptions = {},
  retryPolicy = null,
  retryOptions = {},
  budgetGuard = null,
  runTimeoutMs = 0,
  checkpointer = null,
  resumeState = null,
  runTrace = null,
}) {
  const agentTools = (tools
    || createAgentTools({ trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context })).slice();
  ensureExitPlanModeTool(agentTools, planMode);
  const toolMap = addLazySearchTool(agentTools, lazyTools);
  const buildToolSpecs = () => agentTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolCtx = { trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context };
  const clarified = clarifyBeforeModel
    ? await clarifyPromptBeforeModel({ prompt, userContent, toolMap })
    : { prompt, clarified: false };
  const userMessage = (Array.isArray(userContent) && userContent.length)
    ? { role: 'user', content: userContent }
    : { role: 'user', content: clarified.prompt };
  const activeContextManager = contextManager || createContextManager(contextOptions);
  const activeLoopGuard = loopGuard || createLoopGuard(loopGuardOptions);
  const activeRetryPolicy = retryPolicy || createRetryPolicy(retryOptions);
  const activeBudgetGuard = budgetGuard || createNoopBudgetGuard();
  const resumed = resumeState && typeof resumeState === 'object' ? resumeState : null;
  const resumeUsage = (resumed && resumed.usage) || {};
  const defaultMessages = [{ role: 'system', content: buildSystemPrompt({ memoryText, skills, planMode, developerMode }) }, userMessage];
  let messages = (resumed && Array.isArray(resumed.messages) && resumed.messages.length) ? resumed.messages : defaultMessages;
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
  const saveCheckpoint = (phase, step, checkpointMessages = messages) => {
    if (checkpointRecorder.save(phase, step, checkpointMessages)) lastCheckpointStep = step;
  };
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
    let message;
    try {
      message = await callModelResilient(modelCall, {
        messages,
        tools: toolSpecs,
        kimiConfig,
        fetchImpl,
        signal: runTimeout.signal,
        onContent: (d) => { streamedContent = true; if (d) emit('token', { delta: d }); },
        onReasoning: (d) => { streamedReasoning = true; if (d) emit('reasoning', { delta: d }); },
      }, { kimiConfig, timeoutMs: kimiConfig && kimiConfig.timeoutMs, onFallback: (event) => emit('model_fallback', event) });
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
      const { name, args } = parseToolCall(call);
      emit('tool_call', { name, args });
      const tool = toolMap.get(name);
      const argValidation = tool ? validateToolArguments(tool.parameters, args) : { valid: true, errors: [] };
      if (!argValidation.valid) {
        const result = { error: 'invalid tool arguments', errors: argValidation.errors };
        steps.push({ tool: name, ok: false, invalidArgs: true });
        audit('tool.args_invalid', { tool: name, errors: argValidation.errors });
        emit('tool_args_invalid', { name, errors: argValidation.errors });
        emit('tool_result', { name, status: 'failed', result });
        traceToolResult(runTrace, stepNumber, call, name, 'failed', result);
        const formatted = activeContextManager.formatToolResult(result, { toolName: name });
        messages.push({ role: 'tool', tool_call_id: call.id, content: formatted.content });
        saveCheckpoint('tool_result', stepNumber);
        continue;
      }
      const isMutating = !!(tool && tool.mutating === true);
      const needsApproval = toolNeedsApproval(tool);
      if (await runPreToolHook({ hooks, name, args, steps, audit, emit, messages, call })) {
        saveCheckpoint('tool_result', stepNumber);
        continue;
      }
      const planResult = await handleExitPlanMode({ name, args, hasApprovals, autoApprove, approvals, runId, emit, audit, steps, messages, call, context });
      if (planResult.handled) {
        if (planResult.planApproved) planApproved = true;
        saveCheckpoint('plan_result', stepNumber);
        continue;
      }
      if (blockUntilPlanApproved({ planMode, planApproved, needsApproval, name, tool, steps, audit, emit, messages, call })) {
        saveCheckpoint('tool_result', stepNumber);
        continue;
      }
      if (await requestToolApproval({
        needsApproval, hasApprovals, sessionApproved, name, args, tool, runId,
        approvals, emit, audit, messages, call, autoApprove, planMode, planApproved, steps, context,
      })) {
        saveCheckpoint('approval_result', stepNumber);
        continue;
      }

      const todo = toolTodos.start(name);
      const toolStartedAt = Date.now();
      let result;
      try {
        result = await activeRetryPolicy.run(async () => (
          tool ? tool.handler(args, toolCtx) : { error: `unknown tool: ${name}` }
        ));
      } catch (err) {
        result = { error: err.message };
      }
      const durationMs = Math.max(0, Date.now() - toolStartedAt);
      if (activeRetryPolicy.lastRun.retried) {
        emit('tool_retry', {
          name,
          attempts: activeRetryPolicy.lastRun.attempts,
          errors: activeRetryPolicy.lastRun.errors,
        });
      }
      const ok = !(result && result.error);
      if (ok && needsApproval) didMutate = true;
      if (ok && isMutating && result && result.path) emit('file_written', { path: result.path });
      steps.push({ tool: name, ok, durationMs });
      if (needsApproval) audit('tool.execute', { tool: name, risk: tool.risk, ok });
      todo.finish(ok ? 'done' : 'failed');
      emit('tool_result', { name, status: ok ? 'succeeded' : 'failed', result, durationMs });
      traceToolResult(runTrace, stepNumber, call, name, ok ? 'succeeded' : 'failed', result);
      const formatted = activeContextManager.formatToolResult(result, { toolName: name });
      if (formatted.summarized) {
        emit('tool_result_summary', {
          name,
          beforeTokens: formatted.beforeTokens,
          afterTokens: formatted.afterTokens,
          sources: formatted.sources || [],
        });
      }
      if (formatted.injectionFlagged) {
        emit('untrusted_content_flagged', {
          name,
          reasons: formatted.injectionReasons || [],
        });
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: formatted.content });
      saveCheckpoint('tool_result', stepNumber);
      if (hooks) await hooks.run('post_tool', { name, result, ok });
      const postToolBudgetDecision = activeBudgetGuard.check();
      if (postToolBudgetDecision.shouldAbort) {
        stopOnBudget(postToolBudgetDecision);
        break;
      }
      const guardDecision = activeLoopGuard.observe({ name, args }, ok);
      if (guardDecision.shouldBreak) {
        stopForLoopGuard = true;
        emit('loop_guard_break', {
          name,
          reason: guardDecision.reason,
          repeatCount: guardDecision.repeatCount,
          consecutiveFailures: guardDecision.consecutiveFailures,
        });
        messages.push({ role: 'user', content: `循环护栏已停止当前路径：${guardDecision.reason}` });
        break;
      }
    }
  }

    finalText = await summarizeAfterBudget({ finalText, signal: runTimeout.signal, messages, modelCall, kimiConfig, fetchImpl, emit, usageTotals });
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
