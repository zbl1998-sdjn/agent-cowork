// @ts-check
import { buildUsageTransparency } from './usage.js';

const FAILURE_STATUSES = new Set(['failed', 'error', 'rejected', 'blocked', 'cancelled', 'timeout']);
const SUCCESS_STATUSES = new Set(['succeeded', 'success', 'ok', 'completed', 'done']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function objectAt(source, key) {
  const value = source[key];
  return isRecord(value) ? value : {};
}

/**
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @returns {unknown[]}
 */
function arrayAt(source, key) {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string | number | null | undefined}
 */
function timingStamp(value) {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : undefined;
}

/**
 * @param {unknown} value
 * @returns {number | null | undefined}
 */
function timingDuration(value) {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {Record<string, unknown>} step
 * @returns {string}
 */
function stepTool(step) {
  return text(step.tool || step.name).trim();
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function eventTool(event) {
  return text(event.name || event.tool).trim();
}

/**
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
function failed(item) {
  if (item.ok === false) return true;
  return FAILURE_STATUSES.has(text(item.status).toLowerCase());
}

/**
 * @param {Record<string, unknown>} item
 * @returns {boolean}
 */
function succeeded(item) {
  if (item.ok === true) return true;
  return SUCCESS_STATUSES.has(text(item.status).toLowerCase());
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
function uniqueSorted(names) {
  return Array.from(new Set(names.filter(Boolean))).sort();
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundRate(value) {
  return Number(value.toFixed(4));
}

/**
 * @param {Record<string, unknown>} record
 * @returns {{ usage: unknown, model: string, timing: { startedAt?: string | number | null, finishedAt?: string | number | null, durationMs?: number | null } }}
 */
function usageInput(record) {
  const result = objectAt(record, 'result');
  const existingMetrics = objectAt(record, 'metrics');
  return {
    usage: record.usage || result.usage || result.usageTotals || existingMetrics.tokens || null,
    model: text(record.model || result.model || 'default') || 'default',
    timing: {
      startedAt: timingStamp(record.startedAt),
      finishedAt: timingStamp(record.finishedAt),
      durationMs: timingDuration(record.durationMs),
    },
  };
}

/**
 * @param {Record<string, unknown>} record
 * @returns {{ total: number, succeeded: number, failed: number, stepRecords: Record<string, unknown>[] }}
 */
function countSteps(record) {
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

/**
 * @param {Record<string, unknown>} record
 * @param {Record<string, unknown>[]} stepRecords
 * @returns {{ calls: number, succeeded: number, failed: number, unique: string[] }}
 */
function countTools(record, stepRecords) {
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

/**
 * @param {unknown} record
 * @returns {{ schemaVersion: 1, model: string, status: string, tokens: { prompt_tokens: number, completion_tokens: number, total_tokens: number }, cost: ReturnType<typeof buildUsageTransparency>['cost'], duration: ReturnType<typeof buildUsageTransparency>['duration'], steps: { total: number, succeeded: number, failed: number }, tools: { calls: number, succeeded: number, failed: number, unique: string[] }, failures: { count: number, rate: number, runFailed: boolean } }}
 */
export function buildRunMetrics(record) {
  const source = isRecord(record) ? record : {};
  const { usage, model, timing } = usageInput(source);
  const usageSummary = buildUsageTransparency({ usage, model, timing });
  const { stepRecords, ...steps } = countSteps(source);
  const tools = countTools(source, stepRecords);
  const runFailed = FAILURE_STATUSES.has(text(source.status).toLowerCase());
  const failureCount = Math.max(steps.failed, tools.failed, runFailed ? 1 : 0);
  const denominator = tools.calls || steps.total || (runFailed ? 1 : 0);
  return {
    schemaVersion: 1,
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

/**
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
export function withRunMetrics(record) {
  return {
    ...record,
    metrics: buildRunMetrics(record),
  };
}
