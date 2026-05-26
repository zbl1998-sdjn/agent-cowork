// @ts-check
import {
  isRecord,
  nonEmptyText,
  normalizeToolCall,
  normalizeTools,
  parseMaybeJson,
  sanitizeValue,
} from './run-trace-sanitizers.js';

export const DEFAULT_MAX_TEXT_CHARS = 2000;
export { isRecord, nonEmptyText } from './run-trace-sanitizers.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} runId
 * @returns {string}
 */
export function normalizeRunId(runId) {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) {
    throw new Error('RunTrace: valid runId required');
  }
  return id;
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function normalizeStep(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function toIsoString(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value || ''));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * @param {unknown} messages
 * @param {number} maxTextChars
 * @returns {Record<string, unknown>[]}
 */
export function normalizeMessages(messages, maxTextChars) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const source = isRecord(message) ? message : { content: message };
    /** @type {Record<string, unknown>} */
    const out = { role: nonEmptyText(source.role) || 'unknown' };
    const name = nonEmptyText(source.name);
    const toolCallId = nonEmptyText(source.tool_call_id);
    if (name) out.name = name;
    if (toolCallId) out.tool_call_id = toolCallId;
    if (source.content !== undefined) {
      out.content = sanitizeValue(source.content, { maxTextChars }).value;
    }
    if (source.reasoning_content !== undefined) {
      out.reasoning = sanitizeValue(source.reasoning_content, { maxTextChars }).value;
    }
    if (Array.isArray(source.tool_calls)) {
      out.toolCalls = source.tool_calls.map((call) => normalizeToolCall(call, maxTextChars));
    }
    return out;
  });
}

/**
 * @param {unknown} value
 * @param {number} maxTextChars
 * @returns {{ status: string, result: Record<string, unknown> }}
 */
export function normalizeToolResultPayload(value, maxTextChars) {
  const parsed = parseMaybeJson(value);
  const sanitized = sanitizeValue(parsed, { maxTextChars });
  const result = isRecord(sanitized.value)
    ? { .../** @type {Record<string, unknown>} */ (sanitized.value) }
    : { value: sanitized.value };
  result.truncated = Boolean(sanitized.truncated || result.truncated);
  const status = result.error || result.ok === false ? 'failed' : 'succeeded';
  return { status, result };
}

/**
 * @param {Record<string, unknown>} input
 * @param {number} maxTextChars
 * @returns {{ messages: Record<string, unknown>[], tools: unknown[] }}
 */
function normalizeModelSaw(input, maxTextChars) {
  const modelSaw = isRecord(input.modelSaw) ? input.modelSaw : input;
  return {
    messages: normalizeMessages(modelSaw.messages, maxTextChars),
    tools: normalizeTools(modelSaw.tools, maxTextChars),
  };
}

/**
 * @param {Record<string, unknown>} input
 * @param {number} maxTextChars
 * @returns {{ why: string | undefined, decisions: Array<{ callId: string | undefined, tool: string, args: Record<string, unknown>, why?: string }> }}
 */
export function normalizeToolDecisions(input, maxTextChars) {
  const modelMessage = isRecord(input.modelMessage) ? input.modelMessage : {};
  const rawCalls = Array.isArray(input.toolCalls)
    ? input.toolCalls
    : (Array.isArray(modelMessage.tool_calls) ? modelMessage.tool_calls : null);
  const calls = rawCalls || [input.toolCall || input.call || input];
  const whySource = input.why || input.reason || modelMessage.reasoning_content || modelMessage.content;
  const why = nonEmptyText(sanitizeValue(whySource, { maxTextChars }).value);
  const decisions = calls.map((call) => ({
    ...normalizeToolCall(call, maxTextChars),
    ...(why ? { why } : {}),
  }));
  return { why, decisions };
}

/**
 * @param {Record<string, unknown>} input
 * @param {number} maxTextChars
 * @returns {{ callId: string | undefined, tool: string, status: string, result: Record<string, unknown> }}
 */
function normalizeToolResult(input, maxTextChars) {
  const payload = normalizeToolResultPayload(input.result ?? input.output ?? input.value, maxTextChars);
  return {
    callId: nonEmptyText(input.callId || input.id || input.tool_call_id),
    tool: nonEmptyText(input.tool || input.name) || 'unknown',
    status: nonEmptyText(input.status) || payload.status,
    result: payload.result,
  };
}

/**
 * @param {Record<string, unknown>} input
 * @param {{ runId: string, traceSeq: number, ts: string, maxTextChars: number }} options
 * @returns {Record<string, unknown>}
 */
export function normalizeTraceEntry(input, options) {
  const kind = nonEmptyText(input.kind || input.phase || input.type) || 'event';
  /** @type {Record<string, unknown>} */
  const entry = {
    schemaVersion: 1,
    runId: options.runId,
    traceSeq: options.traceSeq,
    ts: options.ts,
    kind,
  };
  const step = normalizeStep(input.step);
  if (step !== undefined) entry.step = step;

  if (kind === 'model_context') {
    entry.modelSaw = normalizeModelSaw(input, options.maxTextChars);
    return entry;
  }
  if (kind === 'tool_decision') {
    const normalized = normalizeToolDecisions(input, options.maxTextChars);
    if (normalized.why) entry.why = normalized.why;
    entry.decisions = normalized.decisions;
    return entry;
  }
  if (kind === 'tool_result') {
    return { ...entry, ...normalizeToolResult(input, options.maxTextChars) };
  }

  entry.payload = sanitizeValue(input.payload ?? input, { maxTextChars: options.maxTextChars }).value;
  return entry;
}
