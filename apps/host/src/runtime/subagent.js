import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { createRunId, writeRunRecord } from './run-store.js';
import { summariseRunForIndex } from './runs-index.js';

// Sub-agent orchestrator: execute a fixed plan (a sequence of tool calls)
// through the ToolRegistry, recording one `subagent-run` with an event timeline
// shaped exactly like a recipe/sandbox run, so the history + timeline UIs work
// unchanged. This is the "execute" half of plan-then-execute; the plan itself is
// just an array of { tool, args, note } steps decided upstream (by a planner,
// the model, or the UI).
//
// Returns { ok, runId, runPath, goal, steps, events }.

const DEFAULT_CONTEXT_BUDGET_BYTES = 32 * 1024;
const DEFAULT_MAX_STEPS = 20;

function makeHttpError(statusCode, message, payload = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function contextSnapshot({ goal, steps }) {
  return {
    goal: String(goal || ''),
    steps: steps.map((step) => ({
      tool: String(step.tool || ''),
      note: step.note == null ? undefined : String(step.note),
      rationale: step.rationale == null ? undefined : String(step.rationale),
      args: step.args || {},
    })),
  };
}

function enforceSubagentContextBudget({ goal, steps, contextBudgetBytes, maxSteps }) {
  const stepLimit = Math.max(1, Number(maxSteps) || DEFAULT_MAX_STEPS);
  if (steps.length > stepLimit) {
    throw makeHttpError(400, `runSubagent: too many steps; max ${stepLimit}`, { maxSteps: stepLimit });
  }
  const budget = Math.max(1, Number(contextBudgetBytes) || DEFAULT_CONTEXT_BUDGET_BYTES);
  const snapshot = contextSnapshot({ goal, steps });
  const contextBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  if (contextBytes > budget) {
    throw makeHttpError(413, `runSubagent: context budget exceeded (${contextBytes}/${budget} bytes)`, {
      contextBytes,
      contextBudgetBytes: budget,
    });
  }
  return { contextBytes, contextBudgetBytes: budget, maxSteps: stepLimit };
}

function summariseResult(result) {
  if (result == null || typeof result !== 'object') {
    return { value: result === undefined ? null : result };
  }
  if (typeof result.runId === 'string') {
    return { runId: result.runId, ok: result.ok !== false };
  }
  if (typeof result.exitCode === 'number') {
    return { exitCode: result.exitCode, ok: result.exitCode === 0 && !result.timedOut };
  }
  if (Array.isArray(result.content)) {
    const text = result.content
      .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
      .join(' ')
      .slice(0, 500);
    return { content: text };
  }
  return { keys: Object.keys(result).slice(0, 8) };
}

export async function runSubagent({
  goal = '',
  steps = [],
  registry,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context = {},
  stopOnError = true,
  contextBudgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES,
  maxSteps = DEFAULT_MAX_STEPS,
}) {
  if (!registry) {
    throw new Error('runSubagent: registry is required');
  }
  if (!runStoreRoot) {
    throw new Error('runSubagent: runStoreRoot is required');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    const err = new Error('runSubagent: steps must be a non-empty array');
    err.statusCode = 400;
    throw err;
  }
  steps.forEach((step, i) => {
    if (!step || typeof step.tool !== 'string' || !step.tool.trim()) {
      const err = new Error(`runSubagent: steps[${i}].tool is required`);
      err.statusCode = 400;
      throw err;
    }
    if (!registry.has(step.tool)) {
      const err = new Error(`runSubagent: unknown tool "${step.tool}"`);
      err.statusCode = 400;
      throw err;
    }
  });
  const limits = enforceSubagentContextBudget({ goal, steps, contextBudgetBytes, maxSteps });

  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const runId = createRunId();
  const startedAt = new Date();
  const events = [];
  const emit = (type, payload = {}) => {
    const enriched = runEvents
      ? runEvents.publish(runId, { type, ...payload })
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  emit('user_message', { text: String(goal || '').slice(0, 2000) || `子任务 (${steps.length} 步)` });
  emit('assistant_start', { status: 'running', stepCount: steps.length });

  const stepResults = [];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    emit('progress', { icon: 'loader', text: `步骤 ${i + 1}/${steps.length}: 调用 ${step.tool}` });
    try {
      const result = await registry.call(step.tool, step.args || {}, { trustedRoot: safeRoot, context });
      const summary = summariseResult(result);
      stepResults.push({ index: i, tool: step.tool, status: 'succeeded', summary });
      emit('tool_result', { index: i, tool: step.tool, status: 'succeeded', summary });
    } catch (err) {
      ok = false;
      stepResults.push({ index: i, tool: step.tool, status: 'failed', error: err.message });
      emit('tool_result', { index: i, tool: step.tool, status: 'failed', error: err.message });
      if (stopOnError) {
        break;
      }
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  emit('assistant_end', { status: ok ? 'succeeded' : 'failed', durationMs });

  const record = {
    id: runId,
    type: 'subagent-run',
    provider: 'agent-cowork-host',
    command: 'subagent',
    mode: 'agent',
    trustedRoot: safeRoot,
    limits,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    status: ok ? 'succeeded' : 'failed',
    context,
    input: { prompt: String(goal || ''), steps: steps.map((s) => ({ tool: s.tool })) },
    result: { ok, steps: stepResults },
    events,
  };
  const runPath = writeRunRecord(runStoreRoot, record);
  if (runsIndex) {
    try {
      runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, context), context);
    } catch {
      // index failures never break the run
    }
  }

  return { ok, runId, runPath, goal: String(goal || ''), steps: stepResults, events };
}
