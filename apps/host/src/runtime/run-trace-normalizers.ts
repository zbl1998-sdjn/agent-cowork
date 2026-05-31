// 运行追踪·归一化器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把杂乱的消息/工具调用/工具结果归一化成 run-trace 所需的统一结构(解析可能的 JSON、规整工具列表等)。
// 依赖:同层 run-trace-sanitizers。导出:各归一化函数。
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
 * Deep-clone trace payloads before persistence so later runtime mutation cannot
 * rewrite historical audit evidence.
 */
export function jsonClone(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Keep run trace file names jailed to the run id namespace accepted by the
 * existing JS runtime.
 */
export function normalizeRunId(runId: unknown): string {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) {
    throw new Error('RunTrace: valid runId required');
  }
  return id;
}

function normalizeStep(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Normalize caller-provided timestamps while preserving valid Date objects.
 */
export function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value || ''));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function normalizeMessages(messages: unknown, maxTextChars: number): Record<string, unknown>[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const source = (isRecord(message) ? message : { content: message }) as Record<string, unknown>;
    const out: Record<string, unknown> = { role: nonEmptyText(source.role) || 'unknown' };
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
    const toolCalls = Array.isArray(source.tool_calls) ? source.tool_calls : [];
    if (toolCalls.length > 0) {
      out.toolCalls = toolCalls.map((call) => normalizeToolCall(call, maxTextChars));
    }
    return out;
  });
}

/**
 * Convert arbitrary tool output into the stable trace envelope consumed by UI
 * replay and audit readers.
 */
export function normalizeToolResultPayload(value: unknown, maxTextChars: number): { status: string; result: Record<string, unknown> } {
  const parsed = parseMaybeJson(value);
  const sanitized = sanitizeValue(parsed, { maxTextChars });
  const result: Record<string, unknown> = isRecord(sanitized.value)
    ? { ...(sanitized.value as Record<string, unknown>) }
    : { value: sanitized.value };
  result.truncated = Boolean(sanitized.truncated || result.truncated);
  const status = result.error || result.ok === false ? 'failed' : 'succeeded';
  return { status, result };
}

function normalizeModelSaw(input: Record<string, unknown>, maxTextChars: number): { messages: Record<string, unknown>[]; tools: unknown[] } {
  const modelSaw = isRecord(input.modelSaw) ? input.modelSaw : input;
  return {
    messages: normalizeMessages(modelSaw.messages, maxTextChars),
    tools: normalizeTools(modelSaw.tools, maxTextChars),
  };
}

/**
 * Preserve the model's stated rationale next to normalized tool-call decisions.
 */
export function normalizeToolDecisions(
  input: Record<string, unknown>,
  maxTextChars: number,
): { why: string | undefined; decisions: Array<{ callId: string | undefined; tool: string; args: Record<string, unknown>; why?: string }> } {
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

function normalizeToolResult(
  input: Record<string, unknown>,
  maxTextChars: number,
): { callId: string | undefined; tool: string; status: string; result: Record<string, unknown> } {
  const payload = normalizeToolResultPayload(input.result ?? input.output ?? input.value, maxTextChars);
  return {
    callId: nonEmptyText(input.callId || input.id || input.tool_call_id),
    tool: nonEmptyText(input.tool || input.name) || 'unknown',
    status: nonEmptyText(input.status) || payload.status,
    result: payload.result,
  };
}

/**
 * Normalize every trace event into the versioned shape persisted on disk.
 */
export function normalizeTraceEntry(
  input: Record<string, unknown>,
  options: { runId: string; traceSeq: number; ts: string; maxTextChars: number },
): Record<string, unknown> {
  const kind = nonEmptyText(input.kind || input.phase || input.type) || 'event';
  const entry: Record<string, unknown> = {
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
