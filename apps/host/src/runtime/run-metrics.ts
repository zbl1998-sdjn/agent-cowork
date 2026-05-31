// 运行指标(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为每条运行记录补充指标——成功/失败判定、用量与费用透明化、耗时分阶段汇总,供 run-store 写入。
// 依赖:同层 usage。导出:withRunMetrics(给 run 记录附加指标)。
import { buildUsageTransparency, type TimingInput } from './usage.js';

type StepStats = { total: number; succeeded: number; failed: number };
type ToolStats = { calls: number; succeeded: number; failed: number; unique: string[] };
type StepCount = StepStats & { stepRecords: Record<string, unknown>[] };
type UsageInput = { usage: unknown; provider: string; model: string; timing: TimingInput };

export type RunMetrics = {
  schemaVersion: 1;
  provider: string;
  model: string;
  status: string;
  tokens: ReturnType<typeof buildUsageTransparency>['tokens'];
  cost: ReturnType<typeof buildUsageTransparency>['cost'];
  duration: ReturnType<typeof buildUsageTransparency>['duration'];
  steps: StepStats;
  tools: ToolStats;
  failures: { count: number; rate: number; runFailed: boolean };
};

const FAILURE_STATUSES = new Set(['failed', 'error', 'rejected', 'blocked', 'cancelled', 'timeout']);
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'ok', 'completed', 'done']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  return isRecord(value) ? value : {};
}

function arrayAt(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return value == null ? '' : String(value);
}

function timingStamp(value: unknown): string | number | null | undefined {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : undefined;
}

function timingDuration(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function stepTool(step: Record<string, unknown>): string {
  return text(step.tool || step.name).trim();
}

function eventTool(event: Record<string, unknown>): string {
  return text(event.name || event.tool).trim();
}

function failed(item: Record<string, unknown>): boolean {
  if (item.ok === false) return true;
  return FAILURE_STATUSES.has(text(item.status).toLowerCase());
}

function succeeded(item: Record<string, unknown>): boolean {
  if (item.ok === true) return true;
  return SUCCESS_STATUSES.has(text(item.status).toLowerCase());
}

function uniqueSorted(names: string[]): string[] {
  return Array.from(new Set(names.filter(Boolean))).sort();
}

function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

function usageInput(record: Record<string, unknown>): UsageInput {
  const result = objectAt(record, 'result');
  const existingMetrics = objectAt(record, 'metrics');
  const attributionModel = objectAt(objectAt(record, 'attribution'), 'model');
  return {
    usage: record.usage || result.usage || result.usageTotals || existingMetrics.tokens || null,
    provider: text(record.provider || result.provider || attributionModel.provider || existingMetrics.provider || 'unknown') || 'unknown',
    model: text(record.model || result.model || attributionModel.model || existingMetrics.model || 'default') || 'default',
    timing: {
      startedAt: timingStamp(record.startedAt),
      finishedAt: timingStamp(record.finishedAt),
      durationMs: timingDuration(record.durationMs),
    },
  };
}

function countSteps(record: Record<string, unknown>): StepCount {
  const result = objectAt(record, 'result');
  const stepRecords = (arrayAt(result, 'steps').length ? arrayAt(result, 'steps') : arrayAt(record, 'steps'))
    .filter(isRecord);
  if (stepRecords.length) {
    return {
      total: stepRecords.length,
      succeeded: stepRecords.filter(succeeded).length,
      failed: stepRecords.filter(failed).length,
      stepRecords,
    };
  }
  const eventResults = arrayAt(record, 'events')
    .filter(isRecord)
    .filter((event) => text(event.type) === 'tool_result');
  return {
    total: eventResults.length,
    succeeded: eventResults.filter(succeeded).length,
    failed: eventResults.filter(failed).length,
    stepRecords: [],
  };
}

function countTools(record: Record<string, unknown>, stepRecords: Record<string, unknown>[]): ToolStats {
  const stepTools = stepRecords.map(stepTool).filter(Boolean);
  if (stepTools.length) {
    const toolSteps = stepRecords.filter((step) => stepTool(step));
    return {
      calls: toolSteps.length,
      succeeded: toolSteps.filter(succeeded).length,
      failed: toolSteps.filter(failed).length,
      unique: uniqueSorted(stepTools),
    };
  }

  const events = arrayAt(record, 'events').filter(isRecord);
  const calls = events.filter((event) => text(event.type) === 'tool_call');
  const results = events.filter((event) => text(event.type) === 'tool_result');
  const names = calls.map(eventTool).concat(results.map(eventTool));
  return {
    calls: calls.length || results.length,
    succeeded: results.filter(succeeded).length,
    failed: results.filter(failed).length,
    unique: uniqueSorted(names),
  };
}

export function buildRunMetrics(record: unknown): RunMetrics {
  const source = isRecord(record) ? record : {};
  const { usage, provider, model, timing } = usageInput(source);
  const usageSummary = buildUsageTransparency({ usage, provider, model, timing });
  const { stepRecords, ...steps } = countSteps(source);
  const tools = countTools(source, stepRecords);
  const runFailed = FAILURE_STATUSES.has(text(source.status).toLowerCase());
  const failureCount = Math.max(steps.failed, tools.failed, runFailed ? 1 : 0);
  const denominator = tools.calls || steps.total || (runFailed ? 1 : 0);
  return {
    schemaVersion: 1,
    provider: usageSummary.provider,
    model: usageSummary.model,
    status: text(source.status || 'unknown') || 'unknown',
    tokens: usageSummary.tokens,
    cost: usageSummary.cost,
    duration: usageSummary.duration,
    steps,
    tools,
    failures: {
      count: failureCount,
      rate: denominator > 0 ? roundRate(failureCount / denominator) : 0,
      runFailed,
    },
  };
}

export function withRunMetrics<T extends Record<string, unknown>>(record: T): T & { metrics: RunMetrics } {
  return {
    ...record,
    metrics: buildRunMetrics(record),
  };
}
