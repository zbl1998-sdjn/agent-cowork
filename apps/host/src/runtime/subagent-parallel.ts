// 并行子代理(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:并发执行多个子代理计划(受并发上限约束),各自独立产出 run 记录与事件;用于把可并行的子任务一次性铺开。
//       与 subagent.js(单计划顺序执行)互补。依赖:L0 path-policy + 同层 run-store/runs-index。
import path from 'node:path';
import { LOCAL_IDENTITY_SCOPE } from '../security/identity-scope.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { bindRunEventPublisher } from '../util/run-event-publisher.js';
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

export type SubagentStep = { tool?: unknown; args?: unknown; note?: unknown; rationale?: unknown };
export type ParallelAgentInput = { goal?: unknown; task?: unknown; steps?: unknown };
export type ChildPlan = { index: number; goal: string; steps: SubagentStep[] };
export type ContextLimits = { contextBytes: number; contextBudgetBytes: number; maxSteps: number };
export type ToolRegistryLike = {
  has(name: string): boolean;
  call(
    name: string,
    args: Record<string, unknown>,
    context: { trustedRoot: string; context: Record<string, unknown> },
  ): unknown | Promise<unknown>;
};
export type RunEventsLike = {
  publish(runId: string, payload: Record<string, unknown>): ParallelEvent | Promise<ParallelEvent>;
};
export type RunsIndexLike = { upsert(record: unknown, context?: Record<string, unknown>): unknown };
export type ParallelEvent = { seq?: number; ts?: string; type: string; [key: string]: unknown };
export type ChildResult = {
  index: number;
  goal: string;
  runId?: string;
  status: 'succeeded' | 'failed';
  ok: boolean;
  steps?: unknown;
  error?: string;
  limits: ContextLimits;
};
export type RunSubagentsParallelOptions = {
  goal?: unknown;
  agents?: ParallelAgentInput[];
  registry: ToolRegistryLike;
  trustedRoot: string;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  context?: Record<string, unknown>;
  stopOnError?: boolean;
  contextBudgetBytes?: number;
  maxSteps?: number;
  maxAgents?: number;
  maxConcurrency?: number;
};
export type RunSubagentsParallelResult = {
  ok: boolean;
  runId: string;
  runPath: string;
  goal: string;
  children: ChildResult[];
  events: ParallelEvent[];
};
type RunSubagentResult = { ok: boolean; runId: string; steps?: unknown };

export async function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<RunSubagentsParallelResult> {
  const {
  goal = '',
  agents = [],
  registry,
  trustedRoot,
  runStoreRoot,
  runEvents = null,
  runsIndex = null,
  context: suppliedContext,
  stopOnError = true,
  contextBudgetBytes = DEFAULT_CONTEXT_BUDGET_BYTES,
  maxSteps = DEFAULT_MAX_STEPS,
  maxAgents = DEFAULT_MAX_PARALLEL_AGENTS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  } = options;
  const context = Object.hasOwn(options, 'context')
    ? (suppliedContext ?? {})
    : LOCAL_IDENTITY_SCOPE;
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

  const childPlans: ChildPlan[] = agents.map((agent, index) => ({
    index,
    goal: String(agent?.goal || agent?.task || `子任务 ${index + 1}`),
    steps: Array.isArray(agent?.steps) ? agent.steps as SubagentStep[] : [],
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
  const events: ParallelEvent[] = [];
  const scopedRunEvents = bindRunEventPublisher(runEvents, context);
  const emit = async (type: string, payload: Record<string, unknown> = {}): Promise<ParallelEvent> => {
    const enriched: ParallelEvent = scopedRunEvents
      ? await Promise.resolve(scopedRunEvents.publish(runId, { type, ...payload }))
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  const concurrency = Math.max(1, Math.min(Number(maxConcurrency) || DEFAULT_MAX_CONCURRENCY, childPlans.length));
  await emit('user_message', { text: String(goal || '').slice(0, 2000) || `并行子任务 (${childPlans.length} 个)` });
  await emit('assistant_start', { status: 'running', childCount: childPlans.length, maxConcurrency: concurrency });

  const children: (ChildResult | undefined)[] = new Array(childPlans.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= childPlans.length) {
        return;
      }
      const child = childPlans[index];
      const limits = childLimits[index];
      if (!child || !limits) {
        return;
      }
      await emit('child_start', { index, goal: child.goal, stepCount: child.steps.length });
      try {
        const out = await runSubagent({
          goal: child.goal,
          steps: child.steps,
          registry,
          trustedRoot: safeRoot,
          runStoreRoot,
          runEvents: scopedRunEvents,
          runsIndex,
          context: { ...context, parentRunId: runId, childIndex: index },
          stopOnError,
          contextBudgetBytes,
          maxSteps,
        }) as RunSubagentResult;
        const childResult: ChildResult = {
          index,
          goal: child.goal,
          runId: out.runId,
          status: out.ok ? 'succeeded' : 'failed',
          ok: out.ok,
          steps: out.steps,
          limits,
        };
        children[index] = childResult;
        await emit('child_end', { index, runId: out.runId, status: childResult.status });
      } catch (err) {
        const childResult: ChildResult = {
          index,
          goal: child.goal,
          status: 'failed',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          limits,
        };
        children[index] = childResult;
        await emit('child_end', { index, status: 'failed', error: childResult.error });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const childResults = children as ChildResult[];
  const ok = childResults.every((child) => child && child.ok);
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  await emit('assistant_end', { status: ok ? 'succeeded' : 'failed', durationMs });

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
    result: { ok, children: childResults },
    events,
  };
  const runPath = writeRunRecord(runStoreRoot, record);
  if (runsIndex) {
    try {
      runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, context), context);
    } catch {
      // 索引失败不应影响子代理主流程,历史记录已由 run-store 落盘。
    }
  }

  return { ok, runId, runPath, goal: String(goal || ''), children: childResults, events };
}
