import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { createAgentTools } from './agent-tools.js';
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { buildSystemPrompt } from './system-prompt.js';
import { defaultAgentModelCall } from './model-call.js';
import { CircuitBreaker } from '../runtime/circuit-breaker.js';
import { redactText } from '../security/redaction.js';

// Agentic tool-calling loop: the model is given tools (read/write files, run
// code, fetch web) and decides which to call; the host executes them and feeds
// results back until the model produces a final answer. This is what lets Kimi
// Cowork actually do work on local files, like Claude Cowork.

// Re-export so existing importers keep `from agent-runner.js`.
export { defaultAgentModelCall };

// Per-endpoint circuit breakers protect the agent loop from a flaky/slow model
// API (gap #3): after repeated failures the breaker opens and we fail fast with a
// friendly degraded message, instead of hammering a dead upstream and stalling
// every concurrent request behind it.
const MODEL_BREAKERS = new Map();
function modelBreaker(kimiConfig) {
  const key = `${kimiConfig && kimiConfig.baseUrl}|${kimiConfig && kimiConfig.model}`;
  let breaker = MODEL_BREAKERS.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: `model:${key}`, failureThreshold: 4, cooldownMs: 15000 });
    MODEL_BREAKERS.set(key, breaker);
  }
  return breaker;
}

// Snapshot of every model circuit breaker — surfaced by /api/selfcheck so the
// UI can show whether the upstream model API is currently healthy/degraded.
export function modelBreakerStats() {
  return [...MODEL_BREAKERS.values()].map((b) => b.stats());
}

// Wrap a single (streaming) model call with circuit breaking + a hard timeout.
// We deliberately do NOT retry here: the call streams tokens to the client, so a
// mid-stream retry would duplicate output. Retries belong on idempotent calls.
export async function callModelResilient(modelCall, callArgs, { kimiConfig, timeoutMs = 60000 } = {}) {
  return modelBreaker(kimiConfig).run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 60000));
    try {
      return await modelCall({ ...callArgs, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  });
}

// Map a low-level failure to a safe, user-facing message: friendly text for known
// degraded states (open breaker / timeout), redacted text otherwise — never leak
// a stack trace or a secret-bearing error string to the client.
export function friendlyAgentError(err, context) {
  const trace = context && context.traceId ? `（追踪号 ${context.traceId}）` : '';
  if (err && err.code === 'CIRCUIT_OPEN') return `模型服务暂时不可用，已启用熔断保护，请稍后重试${trace}`;
  if (err && err.code === 'ETIMEDOUT') return `模型响应超时，请稍后重试${trace}`;
  const msg = redactText((err && err.message) || '发生未知错误');
  return `${msg}${trace ? ' ' + trace : ''}`;
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
}) {
  const agentTools = (tools
    || createAgentTools({ trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context })).slice();
  // In plan mode the model must first propose a plan via ExitPlanMode before any
  // side effect; expose the tool so the model can call it.
  if (planMode && !agentTools.some((t) => t.name === 'ExitPlanMode')) {
    agentTools.push({
      name: 'ExitPlanMode', mutating: false, risk: 'safe',
      description: '提交一份中文计划草案，等待用户批准后再执行。参数 plan 为计划文本（说明做什么、改哪些文件、分几步）。',
      parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
      handler: async () => ({ note: 'plan handled by agent loop' }),
    });
  }
  // Lazy tool loading (ToolSearch equivalent): instead of front-loading every
  // tool, expose a search_tools meta-tool that activates extra tools on demand.
  // Core file tools stay always-on; bulky connector (mcp) tools arrive as lazy.
  const activeNames = new Set(agentTools.map((t) => t.name));
  if (Array.isArray(lazyTools) && lazyTools.length) {
    agentTools.push({
      name: 'search_tools', risk: 'safe', mutating: false,
      description: '按关键词检索可用的扩展工具(如外部连接器/MCP)。返回匹配工具的名称与描述;被检索到的工具随后即可直接调用。',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      handler: async ({ query = '', limit = 5 } = {}) => {
        const terms = String(query).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
        const ranked = lazyTools
          .filter((t) => !activeNames.has(t.name))
          .map((t) => { const hay = `${t.name} ${t.description || ''}`.toLowerCase(); let sc = 0; for (const term of terms) if (hay.includes(term)) sc += 1; return { t, sc }; })
          .filter((r) => terms.length === 0 || r.sc > 0)
          .sort((a, b) => b.sc - a.sc)
          .slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
        for (const { t } of ranked) { agentTools.push(t); toolMap.set(t.name, t); activeNames.add(t.name); }
        return { activated: ranked.map(({ t }) => ({ name: t.name, description: t.description || '' })) };
      },
    });
  }
  const toolMap = new Map(agentTools.map((t) => [t.name, t]));
  const buildToolSpecs = () => agentTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const toolCtx = { trustedRoot, sandbox, sandboxLimits, runStoreRoot, runEvents, runsIndex, context };
  const userMessage = (Array.isArray(userContent) && userContent.length)
    ? { role: 'user', content: userContent }
    : { role: 'user', content: String(prompt || '') };
  const messages = [{ role: 'system', content: buildSystemPrompt({ memoryText, skills, planMode }) }, userMessage];
  const steps = [];
  let finalText = '';
  const sessionApproved = new Set();
  const hasApprovals = !!approvals;
  // Plan mode starts un-approved; non-plan runs are implicitly "approved".
  let planApproved = !planMode;
  // Self-verification: after the model finishes a run that changed something,
  // do one read-only pass to check its own work (Claude Cowork verification).
  let didMutate = false;
  let verified = false;
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // Audit every side-effecting decision (never let audit break the loop).
  const audit = (kind, extra = {}) => {
    if (!auditBus) return;
    try { auditBus.publish({ kind, ...(context || {}), ...extra }); } catch { /* swallow */ }
  };

  const stepBudget = maxSteps + (verify ? Math.max(0, maxVerifySteps) : 0);
  for (let i = 0; i < stepBudget; i += 1) {
    if (signal && signal.aborted) break;
    let streamedContent = false;
    let streamedReasoning = false;
    const message = await callModelResilient(modelCall, {
      messages, tools: buildToolSpecs(), kimiConfig, fetchImpl,
      onContent: (d) => { streamedContent = true; if (d) emit('token', { delta: d }); },
      onReasoning: (d) => { streamedReasoning = true; if (d) emit('reasoning', { delta: d }); },
    }, { kimiConfig, timeoutMs: kimiConfig && kimiConfig.timeoutMs });
    if (!streamedReasoning && message.reasoning_content) emit('reasoning', { delta: message.reasoning_content });
    if (message.usage) {
      usageTotals.prompt_tokens += Number(message.usage.prompt_tokens || 0);
      usageTotals.completion_tokens += Number(message.usage.completion_tokens || 0);
      usageTotals.total_tokens += Number(message.usage.total_tokens || 0);
    }
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
      const name = call.function && call.function.name;
      let args = {};
      try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch { args = {}; }
      emit('tool_call', { name, args });
      const tool = toolMap.get(name);
      const isMutating = !!(tool && tool.mutating === true);
      // A tool needs approval if it changes state OR is high-risk (Shell / external
      // MCP). This is the centralized ActionPolicy — no side effect slips past it.
      const needsApproval = isMutating || !!(tool && tool.risk === 'high');
      if (hooks) {
        const blockedByHook = hooks.blocked(await hooks.run('pre_tool', { name, args }));
        if (blockedByHook) {
          const r = { error: `被 hook 阻止：${blockedByHook.reason || ''}` };
          steps.push({ tool: name, ok: false, blocked: true });
          audit('tool.hook_blocked', { tool: name, reason: blockedByHook.reason || '' });
          emit('tool_result', { name, status: 'blocked', result: r });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r) });
          continue;
        }
      }
      // Plan mode: ExitPlanMode submits a plan and waits for the user to approve
      // the *whole* plan before any side effect (Claude Cowork plan mode).
      if (name === 'ExitPlanMode') {
        const plan = String((args && (args.plan || args.text)) || '').trim();
        let approved = true;
        if (hasApprovals && !autoApprove) {
          const { id, promise } = approvals.request({ kind: 'plan', plan, runId });
          emit('plan_proposed', { id, plan });
          audit('plan.proposed', { chars: plan.length });
          const decision = await promise;
          approved = decision !== 'reject';
        }
        if (approved) planApproved = true;
        const r = approved
          ? { approved: true, note: '计划已批准，现在按计划执行。' }
          : { approved: false, note: '用户希望继续完善计划。请根据反馈修订后再次调用 ExitPlanMode。' };
        steps.push({ tool: name, ok: true, plan: true, approved });
        audit(approved ? 'plan.approved' : 'plan.rejected', { chars: plan.length });
        emit('tool_result', { name, status: 'succeeded', result: r });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r) });
        continue;
      }
      // Plan not yet approved: block side-effecting tools and steer back to planning.
      if (planMode && !planApproved && needsApproval) {
        const r = { error: '处于计划模式且计划尚未批准：请先用只读工具(Read/Glob/Grep/WebFetch)研究，然后调用 ExitPlanMode 提交计划草案，待用户批准后再执行写操作。' };
        steps.push({ tool: name, ok: false, planBlocked: true });
        audit('tool.plan_blocked', { tool: name, risk: tool ? tool.risk : undefined });
        emit('tool_result', { name, status: 'blocked', result: r });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r) });
        continue;
      }
      // Centralized approval gate: ALL mutating tools require approval. autoApprove
      // (and an approved plan) only cover non-high-risk mutations; high-risk
      // (Shell / external MCP) is ALWAYS explicit. Programmatic callers (no
      // approvals registry) run trusted.
      if (needsApproval && hasApprovals && !sessionApproved.has(name)) {
        const planAuthorized = planMode && planApproved;
        if ((autoApprove || planAuthorized) && tool.risk !== 'high') {
          audit('tool.auto_approved', { tool: name, risk: tool.risk, via: autoApprove ? 'auto' : 'plan' });
        } else {
          const { id, promise } = approvals.request({ name, args, risk: tool.risk, runId });
          emit('approval_request', { id, name, args, risk: tool.risk });
          const decision = await promise;
          if (decision === 'session') sessionApproved.add(name);
          if (decision === 'reject') {
            const rejected = { error: '用户拒绝了该操作' };
            steps.push({ tool: name, ok: false, rejected: true });
            audit('tool.rejected', { tool: name, risk: tool.risk });
            emit('tool_result', { name, status: 'rejected', result: rejected });
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(rejected) });
            continue;
          }
          audit('tool.approved', { tool: name, risk: tool.risk, decision });
        }
      }
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
      emit('tool_result', { name, status: ok ? 'succeeded' : 'failed', result });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
      if (hooks) await hooks.run('post_tool', { name, result, ok });
    }
  }
  // The loop above only sets `finalText` when the model returns a message with
  // NO tool calls. If we exhausted the step budget while still mid-task (the
  // model kept calling tools), or the model returned an empty message, finalText
  // is '' and the user would see the task simply stop with a blank reply. To keep
  // the UX promise "every run produces an answer", do ONE more turn with NO tools
  // so the model is forced to write a summary of what it did / found. Skipped when
  // the run was aborted (the user cancelled).
  if (!finalText && !(signal && signal.aborted)) {
    try {
      messages.push({
        role: 'user',
        content: '已达到本轮工具调用上限。请不要再调用任何工具，直接用简洁的中文总结你目前已完成的内容和得到的结果，并说明若还有未完成的步骤是什么。',
      });
      const wrap = await callModelResilient(modelCall, {
        messages, tools: [], kimiConfig, fetchImpl,
        onContent: (d) => { if (d) emit('token', { delta: d }); },
        onReasoning: () => {},
      }, { kimiConfig, timeoutMs: kimiConfig && kimiConfig.timeoutMs });
      finalText = (wrap && wrap.content) || '';
      if (wrap && wrap.usage) {
        usageTotals.prompt_tokens += Number(wrap.usage.prompt_tokens || 0);
        usageTotals.completion_tokens += Number(wrap.usage.completion_tokens || 0);
        usageTotals.total_tokens += Number(wrap.usage.total_tokens || 0);
      }
    } catch {
      // fall through to the static backstop below
    }
  }
  // Last-resort backstop: never end a normal (non-cancelled) run with a blank
  // reply — give the user something actionable instead of silence.
  if (!finalText && !(signal && signal.aborted)) {
    finalText = '我执行了几步操作，但还没能在本轮内完成并给出结论。你可以让我"继续"，或把任务说得更具体一些。';
    emit('token', { delta: finalText });
  }
  return { text: finalText, steps, usage: usageTotals, cancelled: !!(signal && signal.aborted) };
}

// Full agent toolset: native file tools + connected MCP/external-connector tools
// + a Skill tool that runs an enabled recipe. MCP tools are risk:'high' (external
// side effects) so they pass through approval; Skill only plans (low risk).
export function buildAgentToolset({ ctx, toolRegistry, skillRegistry, runDeps = {}, agentDeps = null }) {
  const tools = createAgentTools(ctx);
  if (toolRegistry && typeof toolRegistry.list === 'function') {
    for (const d of toolRegistry.list()) {
      if (!d.source || !String(d.source).startsWith('mcp:')) continue;
      tools.push({
        name: d.name,
        risk: 'high',
        mutating: true,
        description: d.description || `外部连接器工具 ${d.name}`,
        parameters: d.inputSchema && d.inputSchema.type ? d.inputSchema : { type: 'object', properties: {} },
        handler: (args) => toolRegistry.call(d.name, args, { trustedRoot: ctx.trustedRoot, context: ctx.context }),
      });
    }
  }
  if (skillRegistry && typeof skillRegistry.get === 'function') {
    tools.push({
      name: 'Skill',
      risk: 'low',
      description: '运行一个已启用的内置 skill（按 id），生成可审批的产物计划。',
      parameters: { type: 'object', properties: { id: { type: 'string' }, prompt: { type: 'string' } }, required: ['id'] },
      handler: async (args = {}) => {
        const sk = skillRegistry.get(args.id);
        if (!sk || !sk.enabled) return { error: `skill not available: ${args.id}` };
        const r = runRecipe({
          recipeId: args.id, trustedRoot: ctx.trustedRoot, prompt: args.prompt || '',
          context: ctx.context, runStoreRoot: runDeps.runStoreRoot, runEvents: runDeps.runEvents, runsIndex: runDeps.runsIndex,
        });
        return { skill: args.id, operations: r.operations.length, runId: r.runId };
      },
    });
  }
  if (agentDeps) {
    const baseTools = tools.slice();
    if (agentDeps.approvals) {
      tools.push({
        name: 'AskUserQuestion', risk: 'safe', mutating: false,
        description: '需要用户澄清或在几个方案间做选择时，向用户提一个带选项的问题并等待回答后再继续。参数 question(问题文本)、options(可选, 字符串或 {label,description} 数组)。返回 { answer }。',
        parameters: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] },
        handler: async (args = {}) => {
          const question = String((args && args.question) || '').trim();
          if (!question) return { error: 'question is required' };
          const options = (Array.isArray(args.options) ? args.options : [])
            .slice(0, 8)
            .map((o) => (typeof o === 'string' ? { label: o } : { label: String((o && o.label) || ''), description: (o && o.description) || '' }))
            .filter((o) => o.label);
          const { id, promise } = agentDeps.approvals.request({ kind: 'question', question, options, runId: agentDeps.runId });
          agentDeps.emit('question', { id, question, options });
          const answer = await promise;
          return { answer: typeof answer === 'string' ? answer : String(answer == null ? '' : answer) };
        },
      });
    }
    if (agentDeps.scheduler) {
      tools.push({
        name: 'ScheduleTask', risk: 'low', mutating: false,
        description: '为用户创建一个定时任务，到点自动运行。cron 用 5 段 crontab(分 时 日 月 周)做周期任务，或 fireAt 用未来 ISO 时间做一次性。必填 name；通常附 prompt(到点要做什么)或 recipeId。',
        parameters: { type: 'object', properties: { name: { type: 'string' }, cron: { type: 'string' }, fireAt: { type: 'string' }, prompt: { type: 'string' }, recipeId: { type: 'string' } }, required: ['name'] },
        handler: async (args = {}) => {
          try {
            const rec = agentDeps.scheduler.create({
              name: args.name,
              cron: args.cron || null,
              fireAt: args.fireAt || null,
              payload: { prompt: args.prompt || '', recipeId: args.recipeId || null, trustedRoot: ctx.trustedRoot },
              tenantId: ctx.context && ctx.context.tenantId,
              userId: ctx.context && ctx.context.userId,
              traceId: ctx.context && ctx.context.traceId,
            });
            return { id: rec.id, name: rec.name, kind: rec.kind, nextFireAt: rec.nextFireAt, cronHuman: rec.cronHuman || null };
          } catch (e) { return { error: e.message }; }
        },
      });
    }
    tools.push({
      name: 'Agent',
      risk: 'low',
      description: '派生一个子 Agent 自主完成一个子任务（拥有同样的文件/命令工具）。用于把复杂任务拆解委派，返回子任务的结果摘要。',
      parameters: { type: 'object', properties: { task: { type: 'string', description: '交给子 Agent 的明确子任务' } }, required: ['task'] },
      handler: async (args = {}) => {
        const sub = await runAgentChat({
          prompt: String(args.task || ''),
          kimiConfig: agentDeps.kimiConfig,
          trustedRoot: ctx.trustedRoot,
          tools: baseTools,
          modelCall: agentDeps.modelCall,
          maxSteps: 4,
          approvals: agentDeps.approvals,
          autoApprove: agentDeps.autoApprove,
          auditBus: agentDeps.auditBus,
          hooks: agentDeps.hooks,
          emit: agentDeps.emit,
          sandbox: ctx.sandbox,
          sandboxLimits: ctx.sandboxLimits,
          runStoreRoot: runDeps.runStoreRoot,
          runEvents: runDeps.runEvents,
          runsIndex: runDeps.runsIndex,
          context: ctx.context,
        });
        return { text: sub.text, steps: sub.steps.length };
      },
    });
  }
  return tools;
}

function sse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// SSE wrapper used by POST /api/agent/chat/stream: streams reasoning/tool_call/
// tool_result/token frames and records an `agent-chat` run.
export async function streamAgentChat({
  response,
  requestContext,
  body,
  kimiConfig,
  trustedRoot,
  runStoreRoot,
  runsIndex,
  modelCall,
  sandbox,
  sandboxLimits,
  runEvents,
  approvals = null,
  toolRegistry = null,
  skillRegistry = null,
  userHome,
  cancellation = null,
  request = null,
  scheduler = null,
}) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const runId = createRunId();
  const startedAt = new Date();
  const controller = cancellation ? cancellation.register(runId) : null;
  sse(response, 'start', { runId });
  // Free abandoned work: if the client disconnects mid-stream, cancel the run
  // (stops the loop between steps) and unblock any approval/question it awaits.
  let finished = false;
  const onDisconnect = () => {
    if (finished) return;
    if (cancellation) cancellation.cancel(runId);
    if (approvals && typeof approvals.cancelByRun === 'function') approvals.cancelByRun(runId);
  };
  // ServerResponse 'close' fires when the client drops the SSE connection mid-stream
  // (guarded by `finished` so a normal end() is a no-op). Also watch the request.
  if (response && typeof response.on === 'function') response.on('close', onDisconnect);
  if (request && typeof request.on === 'function') request.on('close', onDisconnect);

  const events = [];
  const emit = (type, data) => { events.push({ type, ...data }); sse(response, type, data); };
  let outcome = { text: '', steps: [] };
  let status = 'succeeded';
  try {
    const agentCtx = { trustedRoot, sandbox, sandboxLimits, context: requestContext };
    const hooks = loadHooksConfig({ trustedRoot, sandbox, sandboxLimits });
    const auditBus = getActionAuditBus(trustedRoot);
    const planMode = body.planMode === true;
    const imageParts = Array.isArray(body.images) && body.images.length
      ? loadImageContentParts({ trustedRoot, paths: body.images })
      : [];
    const userContent = imageParts.length ? [{ type: 'text', text: String(body.prompt || '') }, ...imageParts] : null;
    const agentTools = buildAgentToolset({
      ctx: agentCtx, toolRegistry, skillRegistry, runDeps: { runStoreRoot, runEvents, runsIndex },
      agentDeps: { kimiConfig, modelCall, approvals, autoApprove: body.autoApprove === true, hooks, emit, auditBus, runId, scheduler },
    });
    // Connector (mcp) tools are loaded lazily via the search_tools meta-tool so
    // the prompt stays lean even with many connectors attached.
    const lazyTools = agentTools.filter((t) => String(t.name).startsWith('mcp__'));
    const coreTools = agentTools.filter((t) => !String(t.name).startsWith('mcp__'));
    const memory = loadLayeredMemory({ trustedRoot, userHome });
    const skillsList = skillRegistry && typeof skillRegistry.enabledSkills === 'function'
      ? skillRegistry.enabledSkills().map((sk) => ({ id: sk.id, name: sk.name, description: sk.description }))
      : [];
    outcome = await runAgentChat({
      prompt: body.prompt,
      kimiConfig,
      trustedRoot,
      modelCall,
      tools: coreTools,
      lazyTools,
      hooks,
      memoryText: memory.text,
      skills: skillsList,
      // Clamp client-supplied step budget to a safe range so a request body
      // can't blow up upstream cost / runtime (1..12, default 6).
      maxSteps: Math.min(Math.max(Number(body.maxSteps) || 8, 1), 16),
      verify: body.verify === true || body.thinking === 'deep',
      approvals,
      autoApprove: body.autoApprove === true,
      planMode,
      auditBus,
      emit,
      sandbox,
      sandboxLimits,
      runStoreRoot,
      runEvents,
      runsIndex,
      context: requestContext,
      signal: controller ? controller.signal : null,
      runId,
      userContent,
    });
    if (controller && controller.signal.aborted) {
      status = 'cancelled';
      sse(response, 'cancelled', { runId, text: outcome.text, usage: outcome.usage });
    } else {
      sse(response, 'done', { runId, text: outcome.text, steps: outcome.steps, usage: outcome.usage });
    }
  } catch (err) {
    status = 'failed';
    // Graceful degradation: never surface a raw stack/secret. Known degraded
    // states (open breaker / timeout) get a friendly retry hint; anything else
    // is redacted. The run is still recorded in the finally block.
    sse(response, 'error', { error: friendlyAgentError(err, requestContext), runId });
  } finally {
    finished = true;
    if (cancellation) cancellation.done(runId);
    const finishedAt = new Date();
    const record = {
      id: runId,
      type: 'agent-chat',
      provider: 'kimi-api',
      model: kimiConfig.model,
      mode: 'agent',
      trustedRoot,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status,
      context: requestContext,
      input: { prompt: String(body.prompt || '') },
      result: { ok: status === 'succeeded', text: outcome.text, steps: outcome.steps },
      events,
    };
    try {
      const runPath = writeRunRecord(runStoreRoot, record);
      runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
    } catch {
      // never break the response on record/index failure
    }
    response.end();
  }
}
