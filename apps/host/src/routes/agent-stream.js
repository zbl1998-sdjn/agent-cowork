import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { friendlyAgentError } from '../kimi/agent/model-resilience.js';
import { sse } from '../kimi/agent/finalize.js';
import { runAgentChat } from '../kimi/agent/tool-loop.js';
import { buildAgentToolset } from '../kimi/agent/toolset-builder.js';

function recordAgentRun({
  runStoreRoot,
  runsIndex,
  requestContext,
  runId,
  kimiConfig,
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
    mode: 'agent',
    trustedRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    status,
    context: requestContext,
    input: { prompt: String(prompt || '') },
    result: { ok: status === 'succeeded', text: outcome.text, steps: outcome.steps },
    events,
  };
  try {
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch {
    // never break the response on record/index failure
  }
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
  const runId = createRunId();
  const startedAt = new Date();
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
