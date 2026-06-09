// 子代理编排(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:plan-then-execute 的「执行」一半——把固定计划(一串 { tool, args, note } 步骤)经 ToolRegistry
//       依次执行,记录一条形如 recipe/sandbox 的 `subagent-run`(带事件时间线),使历史/时间线 UI 无需改动。
// 依赖:L0 path-policy + 同层 run-store / runs-index。导出:执行子代理计划的函数。
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { omitUndefined } from '../util/object.js';
import { createRunId, writeRunRecord } from './run-store.js';
import { summariseRunForIndex } from './runs-index.js';

export const DEFAULT_CONTEXT_BUDGET_BYTES = 32 * 1024;
export const DEFAULT_MAX_STEPS = 20;

export type SubagentStep = { tool?: unknown; args?: unknown; note?: unknown; rationale?: unknown };
export type ToolRegistryLike = {
  has(name: string): boolean;
  call(
    name: string,
    args: Record<string, unknown>,
    context: { trustedRoot: string; context: Record<string, unknown> },
  ): unknown | Promise<unknown>;
};
export type RunEventsLike = { publish(runId: string, payload: Record<string, unknown>): SubagentEvent };
export type RunsIndexLike = { upsert(record: unknown, context?: Record<string, unknown>): unknown };
export type HttpErrorFields = { statusCode?: number; payload?: Record<string, unknown> };
export type HttpError = Error & HttpErrorFields;
export type SubagentEvent = { seq?: number; ts?: string; type: string; [key: string]: unknown };
export type SubagentStepResult =
  | { index: number; tool: string; status: 'succeeded'; summary: Record<string, unknown> }
  | { index: number; tool: string; status: 'failed'; error: string };
export type ContextLimits = { contextBytes: number; contextBudgetBytes: number; maxSteps: number };
export type RunSubagentOptions = {
  goal?: unknown;
  steps?: SubagentStep[];
  registry: ToolRegistryLike;
  trustedRoot: string;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  context?: Record<string, unknown>;
  stopOnError?: boolean;
  contextBudgetBytes?: number;
  maxSteps?: number;
};
export type RunSubagentResult = {
  ok: boolean;
  runId: string;
  runPath: string;
  goal: string;
  steps: SubagentStepResult[];
  events: SubagentEvent[];
};

export function makeHttpError(statusCode: number, message: string, payload: Record<string, unknown> = {}): HttpError {
  const err = new Error(message) as HttpError;
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function contextSnapshot({ goal, steps }: { goal: unknown; steps: SubagentStep[] }): {
  goal: string;
  steps: Array<{ tool: string; note?: string; rationale?: string; args: unknown }>;
} {
  return {
    goal: String(goal || ''),
    steps: steps.map((step) => omitUndefined({
      tool: String(step.tool || ''),
      note: step.note == null ? undefined : String(step.note),
      rationale: step.rationale == null ? undefined : String(step.rationale),
      args: step.args || {},
    })),
  };
}

export function enforceSubagentContextBudget({
  goal,
  steps,
  contextBudgetBytes,
  maxSteps,
}: {
  goal?: unknown;
  steps: SubagentStep[];
  contextBudgetBytes?: number;
  maxSteps?: number;
}): ContextLimits {
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

export function validateSubagentSteps({ steps, registry }: { steps?: SubagentStep[]; registry: ToolRegistryLike }): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    const err = new Error('runSubagent: steps must be a non-empty array') as HttpError;
    err.statusCode = 400;
    throw err;
  }
  steps.forEach((step, i) => {
    if (!step || typeof step.tool !== 'string' || !step.tool.trim()) {
      const err = new Error(`runSubagent: steps[${i}].tool is required`) as HttpError;
      err.statusCode = 400;
      throw err;
    }
    if (!registry.has(step.tool)) {
      const err = new Error(`runSubagent: unknown tool "${step.tool}"`) as HttpError;
      err.statusCode = 400;
      throw err;
    }
  });
}

function summariseResult(result: unknown): Record<string, unknown> {
  if (result == null || typeof result !== 'object') {
    return { value: result === undefined ? null : result };
  }
  const objectResult = result as Record<string, unknown>;
  if (typeof objectResult.runId === 'string') {
    return { runId: objectResult.runId, ok: objectResult.ok !== false };
  }
  if (typeof objectResult.exitCode === 'number') {
    return { exitCode: objectResult.exitCode, ok: objectResult.exitCode === 0 && !objectResult.timedOut };
  }
  if (Array.isArray(objectResult.content)) {
    const text = objectResult.content
      .map((part) => {
        const contentPart = part as { text?: unknown } | null | undefined;
        return contentPart && typeof contentPart.text === 'string' ? contentPart.text : '';
      })
      .join(' ')
      .slice(0, 500);
    return { content: text };
  }
  return { keys: Object.keys(objectResult).slice(0, 8) };
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
}: RunSubagentOptions): Promise<RunSubagentResult> {
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
  const events: SubagentEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown> = {}): SubagentEvent => {
    const enriched = runEvents
      ? runEvents.publish(runId, { type, ...payload })
      : { seq: events.length + 1, ts: new Date().toISOString(), type, ...payload };
    events.push(enriched);
    return enriched;
  };

  emit('user_message', { text: String(goal || '').slice(0, 2000) || `子任务 (${steps.length} 步)` });
  emit('assistant_start', { status: 'running', stepCount: steps.length });

  const stepResults: SubagentStepResult[] = [];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const tool = String(step.tool || '');
    emit('progress', { icon: 'loader', text: `步骤 ${i + 1}/${steps.length}: 调用 ${tool}` });
    try {
      const result = await registry.call(tool, (step.args || {}) as Record<string, unknown>, { trustedRoot: safeRoot, context });
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
      // 索引失败不应影响子代理主流程,历史记录已由 run-store 落盘。
    }
  }

  return { ok, runId, runPath, goal: String(goal || ''), steps: stepResults, events };
}
