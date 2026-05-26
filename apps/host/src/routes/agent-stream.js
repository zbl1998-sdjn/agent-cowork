// @ts-check
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { createRunTrace } from '../runtime/run-trace.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { friendlyAgentError } from '../kimi/agent/model-resilience.js';
import { sse } from '../kimi/agent/finalize.js';
import { runAgentChat } from '../kimi/agent/tool-loop.js';
import { buildAgentToolset } from '../kimi/agent/toolset-builder.js';
import { resolveAgentRunStart } from './agent-resume.js';
import { applySessionModelConfig } from './session-model-config.js';
import { createAgentBudgetGuard, resolveAgentRunTimeoutMs } from './agent-stream-budget.js';
import { recordAgentRun } from './agent-stream-record.js';

/**
 * @typedef {Record<string, unknown> & { prompt?: unknown, images?: unknown, autoApprove?: unknown, maxSteps?: unknown, verify?: unknown, thinking?: unknown, planMode?: unknown, developerMode?: unknown, mode?: unknown, clarifyBeforeModel?: unknown, autoClarify?: unknown }} RequestBody
 * @typedef {{ write(chunk?: string | Buffer): unknown, writeHead(status: number, headers?: Record<string, string>): unknown, end(chunk?: string): unknown, on?(event: string, listener: () => void): unknown }} ResponseLike
 * @typedef {{ on?(event: string, listener: () => void): unknown }} RequestLike
 * @typedef {{ signal: AbortSignal }} RunController
 * @typedef {{ register(runId: string): RunController, cancel(runId: string): unknown, done(runId: string): unknown }} CancellationRegistry
 * @typedef {import('../kimi/agent/toolset-builder.js').SkillRegistry & { enabledSkills?: () => Array<{ id: unknown, name: unknown, description?: unknown }> }} SkillRegistryLike
 * @typedef {import('../kimi/agent/approval-gate.js').RequestContext} RequestContext
 * @typedef {import('../kimi/agent/approval-gate.js').ApprovalRegistry & { cancelByRun?: (runId: string) => unknown }} ApprovalRegistry
 * @typedef {{ publish(runId: string, event: Record<string, unknown>): unknown }} RunEventsLike
 * @typedef {{ text: unknown, steps: unknown[], usage?: unknown }} AgentOutcome
 * @typedef {{ response: ResponseLike, requestContext: RequestContext, body: RequestBody, kimiConfig: Record<string, unknown>, trustedRoot: string, runStoreRoot: string, runsIndex: import('./agent-stream-record.js').RunsIndexLike, modelCall?: import('../kimi/agent/model-resilience.js').ModelCall, sandbox?: import('../kimi/agent-tools.js').SandboxLike, sandboxLimits?: import('../kimi/agent-tools.js').SandboxLimits, runEvents?: RunEventsLike | null, approvals?: ApprovalRegistry | null, toolRegistry?: import('../kimi/agent/toolset-builder.js').ToolRegistry | null, skillRegistry?: SkillRegistryLike | null, userHome?: string, cancellation?: CancellationRegistry | null, request?: RequestLike | null, scheduler?: import('../kimi/agent/toolset-builder.js').Scheduler | null }} StreamAgentChatOptions
 */

/** @param {StreamAgentChatOptions} options */
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
  const { runId, startedAt, resumed, checkpointer, resumeState } = resolveAgentRunStart({ body, runStoreRoot });
  const runKimiConfig = applySessionModelConfig(kimiConfig, body);
  if (resumed && !resumeState) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '没有找到可续跑的检查点。', runId }));
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const controller = cancellation ? cancellation.register(runId) : null;
  sse(response, 'start', { runId, resumed: !!resumeState });

  let finished = false;
  const onDisconnect = () => {
    if (finished) return;
    if (cancellation) cancellation.cancel(runId);
    if (approvals && typeof approvals.cancelByRun === 'function') approvals.cancelByRun(runId);
  };
  if (response && typeof response.on === 'function') response.on('close', onDisconnect);
  if (request && typeof request.on === 'function') request.on('close', onDisconnect);

  /** @type {Array<Record<string, unknown>>} */
  const events = [];
  /** @type {(type: string, data: Record<string, unknown>) => void} */
  const emit = (type, data) => { events.push({ type, ...data }); sse(response, type, data); };
  /** @type {AgentOutcome} */
  let outcome = { text: '', steps: [] };
  let status = 'succeeded';
  try {
    const agentCtx = { trustedRoot, sandbox, sandboxLimits, context: requestContext };
    const hooks = loadHooksConfig({
      trustedRoot,
      sandbox: /** @type {import('../runtime/hooks.js').SandboxLike | null | undefined} */ (/** @type {unknown} */ (sandbox)),
      sandboxLimits,
    });
    const auditBus = getActionAuditBus(trustedRoot);
    const imageParts = Array.isArray(body.images) && body.images.length
      ? loadImageContentParts({ trustedRoot, paths: body.images })
      : [];
    const userContent = imageParts.length ? [{ type: 'text', text: String(body.prompt || '') }, ...imageParts] : null;
    /** @type {NonNullable<import('../kimi/agent/toolset-builder.js').AgentDeps['runAgentChat']>} */
    const subAgentRunner = (args) => runAgentChat(/** @type {Parameters<typeof runAgentChat>[0]} */ (/** @type {unknown} */ (args)));
    const agentTools = buildAgentToolset({
      ctx: agentCtx,
      toolRegistry,
      skillRegistry,
      runDeps: { runStoreRoot, runEvents, runsIndex },
      agentDeps: {
        kimiConfig: runKimiConfig,
        modelCall,
        approvals,
        autoApprove: body.autoApprove === true,
        hooks,
        emit,
        auditBus,
        runId,
        scheduler,
        runAgentChat: subAgentRunner,
      },
    });
    const lazyTools = agentTools.filter((t) => String(t.name).startsWith('mcp__'));
    const coreTools = agentTools.filter((t) => !String(t.name).startsWith('mcp__'));
    const memory = loadLayeredMemory({ trustedRoot, userHome });
    const runTimeoutMs = resolveAgentRunTimeoutMs(body, runKimiConfig);
    const budgetGuard = createAgentBudgetGuard({ body, kimiConfig: runKimiConfig, startedAt, runTimeoutMs });
    const runTrace = createRunTrace({ runId, runEvents });
    const skills = skillRegistry && typeof skillRegistry.enabledSkills === 'function'
      ? skillRegistry.enabledSkills().map((sk) => ({ id: sk.id, name: sk.name, description: sk.description }))
      : [];
    outcome = await runAgentChat(/** @type {Parameters<typeof runAgentChat>[0]} */ ({
      prompt: body.prompt,
      kimiConfig: runKimiConfig,
      trustedRoot,
      modelCall,
      tools: coreTools,
      lazyTools,
      hooks,
      memoryText: memory.text,
      skills,
      maxSteps: Math.min(Math.max(Number(body.maxSteps) || 8, 1), 16),
      verify: body.verify === true || body.thinking === 'deep',
      approvals,
      autoApprove: body.autoApprove === true,
      planMode: body.planMode === true,
      developerMode: body.developerMode === true || body.mode === 'developer',
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
      clarifyBeforeModel: body.clarifyBeforeModel === true || body.autoClarify === true,
      budgetGuard,
      runTimeoutMs,
      checkpointer,
      resumeState,
      runTrace,
    }));
    if (controller && controller.signal.aborted) {
      status = 'cancelled';
      sse(response, 'cancelled', { runId, text: outcome.text, usage: outcome.usage });
    } else {
      sse(response, 'done', { runId, text: outcome.text, steps: outcome.steps, usage: outcome.usage });
    }
  } catch (err) {
    status = 'failed';
    sse(response, 'error', { error: friendlyAgentError(err, /** @type {{ traceId?: unknown }} */ (requestContext)), runId });
  } finally {
    finished = true;
    if (cancellation) cancellation.done(runId);
    recordAgentRun({
      runStoreRoot,
      runsIndex,
      requestContext,
      runId,
      kimiConfig: runKimiConfig,
      body,
      trustedRoot,
      startedAt,
      status,
      prompt: body.prompt,
      outcome,
      events,
    });
    response.end();
  }
}
