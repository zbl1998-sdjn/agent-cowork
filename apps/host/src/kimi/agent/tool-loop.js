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
  const messages = [{ role: 'system', content: buildSystemPrompt({ memoryText, skills, planMode, developerMode }) }, userMessage];
  const steps = [];
  const sessionApproved = new Set();
  const hasApprovals = !!approvals;
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const audit = makeAudit(auditBus, context);
  let finalText = '';
  let planApproved = !planMode;
  let didMutate = false;
  let verified = false;
  const toolTodos = createToolTodoTracker(emit);

  const stepBudget = maxSteps + (verify ? Math.max(0, maxVerifySteps) : 0);
  for (let i = 0; i < stepBudget; i += 1) {
    if (signal && signal.aborted) break;
    let streamedContent = false;
    let streamedReasoning = false;
    const message = await callModelResilient(modelCall, {
      messages,
      tools: buildToolSpecs(),
      kimiConfig,
      fetchImpl,
      onContent: (d) => { streamedContent = true; if (d) emit('token', { delta: d }); },
      onReasoning: (d) => { streamedReasoning = true; if (d) emit('reasoning', { delta: d }); },
    }, { kimiConfig, timeoutMs: kimiConfig && kimiConfig.timeoutMs });
    if (!streamedReasoning && message.reasoning_content) emit('reasoning', { delta: message.reasoning_content });
    addUsage(usageTotals, message.usage);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0) {
      finalText = message.content || '';
      if (verify && didMutate && !verified && !planMode) {
        verified = true;
        emit('verify_start', {});
        audit('verify.start', {});
        messages.push({ role: 'assistant', content: finalText });
        messages.push({ role: 'user', content: '请用只读工具(Read/Glob/Grep)读回你刚才改动或新建的文件，核对内容是否正确、完整。如发现问题请修正；确认无误后用一句话中文总结结果。' });
        continue;
      }
      if (!streamedContent && finalText) emit('token', { delta: finalText });
      break;
    }

    messages.push({ role: 'assistant', content: message.content || '', tool_calls: calls, ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) });
    for (const call of calls) {
      const { name, args } = parseToolCall(call);
      emit('tool_call', { name, args });
      const tool = toolMap.get(name);
      const isMutating = !!(tool && tool.mutating === true);
      const needsApproval = toolNeedsApproval(tool);
      if (await runPreToolHook({ hooks, name, args, steps, audit, emit, messages, call })) continue;
      const planResult = await handleExitPlanMode({ name, args, hasApprovals, autoApprove, approvals, runId, emit, audit, steps, messages, call });
      if (planResult.handled) {
        if (planResult.planApproved) planApproved = true;
        continue;
      }
      if (blockUntilPlanApproved({ planMode, planApproved, needsApproval, name, tool, steps, audit, emit, messages, call })) continue;
      if (await requestToolApproval({
        needsApproval, hasApprovals, sessionApproved, name, args, tool, runId,
        approvals, emit, audit, messages, call, autoApprove, planMode, planApproved, steps,
      })) continue;

      const todo = toolTodos.start(name);
      let result;
      try {
        result = tool ? await tool.handler(args, toolCtx) : { error: `unknown tool: ${name}` };
      } catch (err) {
        result = { error: err.message };
      }
      const ok = !(result && result.error);
      if (ok && needsApproval) didMutate = true;
      if (ok && isMutating && result && result.path) emit('file_written', { path: result.path });
      steps.push({ tool: name, ok });
      if (needsApproval) audit('tool.execute', { tool: name, risk: tool.risk, ok });
      todo.finish(ok ? 'done' : 'failed');
      emit('tool_result', { name, status: ok ? 'succeeded' : 'failed', result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
      if (hooks) await hooks.run('post_tool', { name, result, ok });
    }
  }

  finalText = await summarizeAfterBudget({ finalText, signal, messages, modelCall, kimiConfig, fetchImpl, emit, usageTotals });
  finalText = applyStaticBackstop(finalText, signal, emit);
  return { text: finalText, steps, usage: usageTotals, cancelled: !!(signal && signal.aborted) };
}
