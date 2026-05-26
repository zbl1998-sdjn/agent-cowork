// @ts-check
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { createRunId, writeRunRecord } from './run-store.js';
import { summariseRunForIndex } from './runs-index.js';
import {
  DEFAULT_CONTEXT_BUDGET_BYTES,
  DEFAULT_MAX_STEPS,
  enforceSubagentContextBudget,
  makeHttpError,
  runSubagent,
  validateSubagentSteps,
} from './subagent.js';

const DEFAULT_MAX_PARALLEL_AGENTS = 8;
const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * @typedef {{ tool?: unknown, args?: unknown, note?: unknown, rationale?: unknown }} SubagentStep
 * @typedef {{ goal?: unknown, task?: unknown, steps?: unknown }} ParallelAgentInput
 * @typedef {{ index: number, goal: string, steps: SubagentStep[] }} ChildPlan
 * @typedef {{ contextBytes: number, contextBudgetBytes: number, maxSteps: number }} ContextLimits
 * @typedef {{ has(name: string): boolean, call(name: string, args: Record<string, unknown>, context: { trustedRoot: string, context: Record<string, unknown> }): unknown | Promise<unknown> }} ToolRegistryLike
 * @typedef {{ publish(runId: string, payload: Record<string, unknown>): ParallelEvent }} RunEventsLike
 * @typedef {{ upsert(record: unknown, context?: Record<string, unknown>): unknown }} RunsIndexLike
 * @typedef {{ seq?: number, ts?: string, type: string, [key: string]: unknown }} ParallelEvent
 * @typedef {{ index: number, goal: string, runId?: string, status: 'succeeded' | 'failed', ok: boolean, steps?: unknown, error?: string, limits: ContextLimits }} ChildResult
 * @typedef {{ goal?: unknown, agents?: ParallelAgentInput[], registry: ToolRegistryLike, trustedRoot: string, runStoreRoot: string, runEvents?: RunEventsLike | null, runsIndex?: RunsIndexLike | null, context?: Record<string, unknown>, stopOnError?: boolean, contextBudgetBytes?: number, maxSteps?: number, maxAgents?: number, maxConcurrency?: number }} RunSubagentsParallelOptions
 */

/** @param {RunSubagentsParallelOptions} options */
export async function runSubagentsParallel({
  goal = '',
  agents = [],
  registry,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context = {},
  stopOnError = true,
  contextBudgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES,
  maxSteps = DEFAULT_MAX_STEPS,
  maxAgents = DEFAULT_MAX_PARALLEL_AGENTS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
}) {
  if (!registry) {
    throw new Error('runSubagentsParallel: registry is required');
  }
  if (!runStoreRoot) {
    throw new Error('runSubagentsParallel: runStoreRoot is required');
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    throw makeHttpError(400, 'runSubagentsParallel: agents must be a non-empty array');
  }
  const agentLimit = Math.max(1, Number(maxAgents) || DEFAULT_MAX_PARALLEL_AGENTS);
  if (agents.length > agentLimit) {
    throw makeHttpError(400, `runSubagentsParallel: too many agents; max ${agentLimit}`, { maxAgents: agentLimit });
  }

  /** @type {ChildPlan[]} */
  const childPlans = agents.map((agent, index) => ({
    index,
    goal: String(agent?.goal || agent?.task || `子任务 ${index + 1}`),
    steps: Array.isArray(agent?.steps) ? /** @type {SubagentStep[]} */ (agent.steps) : [],
  }));
  const childLimits = childPlans.map((child) => {
    validateSubagentSteps({ steps: child.steps, registry });
    return enforceSubagentContextBudget({
      goal: child.goal,
      steps: child.steps,
      contextBudgetBytes,
      maxSteps,
    });
  });

  const safeRoot = assertTrustedPath(path.resolve(trustedRoot), path.resolve(trustedRoot));
  const runId = createRunId();
  const startedAt = new Date();
  /** @type {ParallelEvent[]} */
  const events = [];
  /** @param {string} type @param {Record<string, unknown>} [payload] */
  const emit = (type, payload = {}) => {
    const enriched = runEvents
      ? runEvents.publish(runId, { type, ...payload })
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY, childPlans.length));
  emit('user_message', { text: String(goal || '').slice(0, 2000) || `并行子任务 (${childPlans.length} 个)` });
  emit('assistant_start', { status: 'running', childCount: childPlans.length, maxConcurrency: concurrency });

  /** @type {(ChildResult | undefined)[]} */
  const children = new Array(childPlans.length);
  let next = 0;
  /** @returns {Promise<void>} */
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= childPlans.length) {
        return;
      }
      const child = childPlans[index];
      emit('child_start', { index, goal: child.goal, stepCount: child.steps.length });
      try {
        const out = await runSubagent({
          goal: child.goal,
          steps: child.steps,
          registry,
          trustedRoot: safeRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: { ...context, parentRunId: runId, childIndex: index },
          stopOnError,
          contextBudgetBytes,
          maxSteps,
        });
        children[index] = {
          index,
          goal: child.goal,
          runId: out.runId,
          status: out.ok ? 'succeeded' : 'failed',
          ok: out.ok,
          steps: out.steps,
          limits: childLimits[index],
        };
        emit('child_end', { index, runId: out.runId, status: children[index].status });
      } catch (err) {
        children[index] = {
          index,
          goal: child.goal,
          status: 'failed',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          limits: childLimits[index],
        };
        emit('child_end', { index, status: 'failed', error: children[index].error });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = children.every((child) => child && child.ok);
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  emit('assistant_end', { status: ok ? 'succeeded' : 'failed', durationMs });

  const record = {
    id: runId,
    type: 'subagent-parallel-run',
    provider: 'agent-cowork-host',
    command: 'subagent.parallel',
    mode: 'agent',
    trustedRoot: safeRoot,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    status: ok ? 'succeeded' : 'failed',
    context,
    input: {
      prompt: String(goal || ''),
      agents: childPlans.map((child) => ({
        goal: child.goal,
        steps: child.steps.map((step) => ({ tool: String(step.tool || '') })),
      })),
    },
    result: { ok, children },
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

  return { ok, runId, runPath, goal: String(goal || ''), children, events };
}
