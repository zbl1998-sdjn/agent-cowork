import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { createRunCheckpointer } from '../runtime/run-checkpoint.js';
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { createBudgetGuard } from '../runtime/budget-guard.js';
import { createSeededIdSource } from '../util/ids.js';
import { createRunTrace } from '../runtime/run-trace.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { SYSTEM_PROMPT_VERSION } from '../kimi/system-prompt.js';
import { friendlyAgentError } from '../kimi/agent/model-resilience.js';
import { sse } from '../kimi/agent/finalize.js';
import { runAgentChat } from '../kimi/agent/tool-loop.js';
import { buildAgentToolset } from '../kimi/agent/toolset-builder.js';
import { buildAgentConfigSnapshot } from './agent-config-snapshot.js';

function recordAgentRun({
  runStoreRoot,
  runsIndex,
  requestContext,
  runId,
  kimiConfig,
  body,
  trustedRoot,
  startedAt,
  status,
  prompt,
  outcome,
  events,
}) {
  const finishedAt = new Date();
  const record = {
    id: runId,
    type: 'agent-chat',
    provider: 'kimi-api',
    model: kimiConfig.model,
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    promptBuilder: 'agent-system-prompt',
    configSnapshot: buildAgentConfigSnapshot(body, kimiConfig),
    mode: 'agent',
    trustedRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status,
    context: requestContext,
    input: { prompt: String(prompt || '') },
    result: { ok: status === 'succeeded', text: outcome.text, steps: outcome.steps, usage: outcome.usage },
    events,
  };
  try {
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch {
    // never break the response on record/index failure
  }
}

function positiveLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tightestLimit(configValue, requestValue) {
  const fromConfig = positiveLimit(configValue);
  const fromRequest = positiveLimit(requestValue);
  if (fromConfig !== null && fromRequest !== null) return Math.min(fromConfig, fromRequest);
  return fromConfig ?? fromRequest ?? undefined;
}

function budgetInputs(body, kimiConfig) {
  const requestBody = body && typeof body === 'object' ? body : {};
  const config = kimiConfig && typeof kimiConfig === 'object' ? kimiConfig : {};
  const requestBudget = requestBody.budget && typeof requestBody.budget === 'object' ? requestBody.budget : {};
  return { requestBody, config, requestBudget };
}

function resolveAgentRunTimeoutMs(body, kimiConfig) {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return tightestLimit(config.maxAgentWallClockMs, requestBudget.maxWallClockMs ?? requestBody.maxWallClockMs);
}

function createAgentBudgetGuard({ body, kimiConfig, startedAt, runTimeoutMs }) {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return createBudgetGuard({
    maxRunTokens: tightestLimit(config.maxRunTokens, requestBudget.maxRunTokens ?? requestBody.maxRunTokens),
    maxSessionTokens: tightestLimit(config.maxSessionTokens, requestBudget.maxSessionTokens ?? requestBody.maxSessionTokens),
    maxRunCostUsd: tightestLimit(config.maxRunCostUsd, requestBudget.maxRunCostUsd ?? requestBody.maxRunCostUsd),
    maxSessionCostUsd: tightestLimit(config.maxSessionCostUsd, requestBudget.maxSessionCostUsd ?? requestBody.maxSessionCostUsd),
    maxWallClockMs: runTimeoutMs,
    model: config.model,
    startedAtMs: startedAt.getTime(),
  });
}

function createAgentRunIdentity(body) {
  const seed = body && (body.runSeed || body.seed);
  if (!seed) {
    const startedAt = new Date();
    return { runId: createRunId(startedAt), startedAt };
  }
  const ids = createSeededIdSource(seed);
  const startedAt = ids.date();
  return { runId: createRunId(startedAt, { randomHex: ids.randomHex }), startedAt };
}

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
  const { runId, startedAt } = createAgentRunIdentity(body);
  const controller = cancellation ? cancellation.register(runId) : null;
  sse(response, 'start', { runId });

  let finished = false;
  const onDisconnect = () => {
    if (finished) return;
    if (cancellation) cancellation.cancel(runId);
    if (approvals && typeof approvals.cancelByRun === 'function') approvals.cancelByRun(runId);
  };
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
    const imageParts = Array.isArray(body.images) && body.images.length
      ? loadImageContentParts({ trustedRoot, paths: body.images })
      : [];
    const userContent = imageParts.length ? [{ type: 'text', text: String(body.prompt || '') }, ...imageParts] : null;
    const agentTools = buildAgentToolset({
      ctx: agentCtx,
      toolRegistry,
      skillRegistry,
      runDeps: { runStoreRoot, runEvents, runsIndex },
      agentDeps: {
        kimiConfig,
        modelCall,
        approvals,
        autoApprove: body.autoApprove === true,
        hooks,
        emit,
        auditBus,
        runId,
        scheduler,
        runAgentChat,
      },
    });
    const lazyTools = agentTools.filter((t) => String(t.name).startsWith('mcp__'));
    const coreTools = agentTools.filter((t) => !String(t.name).startsWith('mcp__'));
    const memory = loadLayeredMemory({ trustedRoot, userHome });
    const runTimeoutMs = resolveAgentRunTimeoutMs(body, kimiConfig);
    const budgetGuard = createAgentBudgetGuard({ body, kimiConfig, startedAt, runTimeoutMs });
    const runTrace = createRunTrace({ runId, runEvents });
    const skills = skillRegistry && typeof skillRegistry.enabledSkills === 'function'
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
      checkpointer: runStoreRoot ? createRunCheckpointer({ root: runStoreRoot }) : null,
      runTrace,
    });
    if (controller && controller.signal.aborted) {
      status = 'cancelled';
      sse(response, 'cancelled', { runId, text: outcome.text, usage: outcome.usage });
    } else {
      sse(response, 'done', { runId, text: outcome.text, steps: outcome.steps, usage: outcome.usage });
    }
  } catch (err) {
    status = 'failed';
    sse(response, 'error', { error: friendlyAgentError(err, requestContext), runId });
  } finally {
    finished = true;
    if (cancellation) cancellation.done(runId);
    recordAgentRun({
      runStoreRoot,
      runsIndex,
      requestContext,
      runId,
      kimiConfig,
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
