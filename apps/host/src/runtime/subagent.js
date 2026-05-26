// @ts-check
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

export { DEFAULT_CONTEXT_BUDGET_BYTES, DEFAULT_MAX_STEPS };

/**
 * @typedef {{ tool?: unknown, args?: unknown, note?: unknown, rationale?: unknown }} SubagentStep
 * @typedef {{ has(name: string): boolean, call(name: string, args: Record<string, unknown>, context: { trustedRoot: string, context: Record<string, unknown> }): unknown | Promise<unknown> }} ToolRegistryLike
 * @typedef {{ publish(runId: string, payload: Record<string, unknown>): SubagentEvent }} RunEventsLike
 * @typedef {{ upsert(record: unknown, context?: Record<string, unknown>): unknown }} RunsIndexLike
 * @typedef {{ statusCode?: number, payload?: Record<string, unknown> }} HttpErrorFields
 * @typedef {Error & HttpErrorFields} HttpError
 * @typedef {{ seq?: number, ts?: string, type: string, [key: string]: unknown }} SubagentEvent
 * @typedef {{ index: number, tool: string, status: 'succeeded', summary: Record<string, unknown> } | { index: number, tool: string, status: 'failed', error: string }} SubagentStepResult
 * @typedef {{ goal?: unknown, steps?: SubagentStep[], registry: ToolRegistryLike, trustedRoot: string, runStoreRoot: string, runEvents?: RunEventsLike | null, runsIndex?: RunsIndexLike | null, context?: Record<string, unknown>, stopOnError?: boolean, contextBudgetBytes?: number, maxSteps?: number }} RunSubagentOptions
 */

/** @param {number} statusCode @param {string} message @param {Record<string, unknown>} [payload] @returns {HttpError} */
export function makeHttpError(statusCode, message, payload = {}) {
  const err = /** @type {HttpError} */ (new Error(message));
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

/** @param {{ goal: unknown, steps: SubagentStep[] }} input */
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

/** @param {{ goal?: unknown, steps: SubagentStep[], contextBudgetBytes?: number, maxSteps?: number }} input */
export function enforceSubagentContextBudget({ goal, steps, contextBudgetBytes, maxSteps }) {
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

/** @param {{ steps?: SubagentStep[], registry: ToolRegistryLike }} input */
export function validateSubagentSteps({ steps, registry }) {
  if (!Array.isArray(steps) || steps.length === 0) {
    const err = /** @type {HttpError} */ (new Error('runSubagent: steps must be a non-empty array'));
    err.statusCode = 400;
    throw err;
  }
  steps.forEach((step, i) => {
    if (!step || typeof step.tool !== 'string' || !step.tool.trim()) {
      const err = /** @type {HttpError} */ (new Error(`runSubagent: steps[${i}].tool is required`));
      err.statusCode = 400;
      throw err;
    }
    if (!registry.has(step.tool)) {
      const err = /** @type {HttpError} */ (new Error(`runSubagent: unknown tool "${step.tool}"`));
      err.statusCode = 400;
      throw err;
    }
  });
}

/** @param {unknown} result @returns {Record<string, unknown>} */
function summariseResult(result) {
  if (result == null || typeof result !== 'object') {
    return { value: result === undefined ? null : result };
  }
  const objectResult = /** @type {Record<string, unknown>} */ (result);
  if (typeof objectResult.runId === 'string') {
    return { runId: objectResult.runId, ok: objectResult.ok !== false };
  }
  if (typeof objectResult.exitCode === 'number') {
    return { exitCode: objectResult.exitCode, ok: objectResult.exitCode === 0 && !objectResult.timedOut };
  }
  if (Array.isArray(objectResult.content)) {
    const text = objectResult.content
      .map((part) => {
        const contentPart = /** @type {{ text?: unknown } | null | undefined} */ (part);
        return contentPart && typeof contentPart.text === 'string' ? contentPart.text : '';
      })
      .join(' ')
      .slice(0, 500);
    return { content: text };
  }
  return { keys: Object.keys(objectResult).slice(0, 8) };
}

/** @param {RunSubagentOptions} options */
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
  validateSubagentSteps({ steps, registry });
  const limits = enforceSubagentContextBudget({ goal, steps, contextBudgetBytes, maxSteps });

  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const runId = createRunId();
  const startedAt = new Date();
  /** @type {SubagentEvent[]} */
  const events = [];
  /** @param {string} type @param {Record<string, unknown>} [payload] */
  const emit = (type, payload = {}) => {
    const enriched = runEvents
      ? runEvents.publish(runId, { type, ...payload })
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  emit('user_message', { text: String(goal || '').slice(0, 2000) || `子任务 (${steps.length} 步)` });
  emit('assistant_start', { status: 'running', stepCount: steps.length });

  /** @type {SubagentStepResult[]} */
  const stepResults = [];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const tool = String(step.tool || '');
    emit('progress', { icon: 'loader', text: `步骤 ${i + 1}/${steps.length}: 调用 ${tool}` });
    try {
      const result = await registry.call(tool, /** @type {Record<string, unknown>} */ (step.args || {}), { trustedRoot: safeRoot, context });
      const summary = summariseResult(result);
      stepResults.push({ index: i, tool, status: 'succeeded', summary });
      emit('tool_result', { index: i, tool, status: 'succeeded', summary });
    } catch (err) {
      ok = false;
      const message = err instanceof Error ? err.message : String(err);
      stepResults.push({ index: i, tool, status: 'failed', error: message });
      emit('tool_result', { index: i, tool, status: 'failed', error: message });
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
    input: { prompt: String(goal || ''), steps: steps.map((s) => ({ tool: String(s.tool || '') })) },
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
