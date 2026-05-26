// @ts-check
import {
  DEFAULT_MAX_TEXT_CHARS,
  isRecord,
  jsonClone,
  nonEmptyText,
  normalizeMessages,
  normalizeRunId,
  normalizeToolDecisions,
  normalizeToolResultPayload,
  normalizeTraceEntry,
  toIsoString,
} from './run-trace-normalizers.js';

export class RunTrace {
  /**
   * @param {{ runId?: string, runEvents?: { publish(runId: string, event: Record<string, unknown>): unknown } | null, now?: () => Date | string, maxTextChars?: number }} [options]
   */
  constructor({ runId, runEvents = null, now = () => new Date(), maxTextChars = DEFAULT_MAX_TEXT_CHARS } = {}) {
    this.runId = normalizeRunId(runId);
    this.runEvents = runEvents;
    this.now = now;
    this.maxTextChars = Math.max(80, Math.floor(Number(maxTextChars) || DEFAULT_MAX_TEXT_CHARS));
    /** @type {Record<string, unknown>[]} */
    this.entries = [];
    this.traceSeq = 0;
  }

  /**
   * @param {Record<string, unknown>} event
   * @returns {Record<string, unknown>}
   */
  append(event) {
    if (!isRecord(event)) {
      throw new Error('RunTrace.append: event object required');
    }
    this.traceSeq += 1;
    const entry = normalizeTraceEntry(event, {
      runId: this.runId,
      traceSeq: this.traceSeq,
      ts: toIsoString(this.now()),
      maxTextChars: this.maxTextChars,
    });
    const cloned = /** @type {Record<string, unknown>} */ (jsonClone(entry));
    this.entries.push(cloned);
    if (this.runEvents && typeof this.runEvents.publish === 'function') {
      this.runEvents.publish(this.runId, { type: 'run_trace', trace: cloned });
    }
    return /** @type {Record<string, unknown>} */ (jsonClone(cloned));
  }

  /**
   * @param {{ after?: number }} [options]
   * @returns {Record<string, unknown>[]}
   */
  replay({ after = 0 } = {}) {
    const floor = Number(after) || 0;
    return this.entries
      .filter((entry) => Number(entry.traceSeq) > floor)
      .map((entry) => /** @type {Record<string, unknown>} */ (jsonClone(entry)));
  }
}

/**
 * @param {{ runId?: string, runEvents?: { publish(runId: string, event: Record<string, unknown>): unknown } | null, now?: () => Date | string, maxTextChars?: number }} [options]
 * @returns {RunTrace}
 */
export function createRunTrace(options = {}) {
  return new RunTrace(options);
}

/**
 * @param {unknown[]} events
 * @param {{ after?: number }} [options]
 * @returns {Record<string, unknown>[]}
 */
export function replayRunTraceEvents(events, { after = 0 } = {}) {
  if (!Array.isArray(events)) return [];
  const floor = Number(after) || 0;
  return events
    .filter(isRecord)
    .filter((event) => event.type === 'run_trace')
    .map((event) => (isRecord(event.trace) ? event.trace : event.entry))
    .filter(isRecord)
    .filter((entry) => Number(entry.traceSeq) > floor)
    .sort((a, b) => (Number(a.traceSeq) || Number(a.seq) || 0) - (Number(b.traceSeq) || Number(b.seq) || 0))
    .map((entry) => /** @type {Record<string, unknown>} */ (jsonClone(entry)));
}

/**
 * @param {unknown} message
 * @returns {message is Record<string, unknown>}
 */
function isAssistantToolDecision(message) {
  return isRecord(message) && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

/**
 * @param {unknown} message
 * @returns {message is Record<string, unknown>}
 */
function isToolMessage(message) {
  return isRecord(message) && message.role === 'tool';
}

/**
 * @param {unknown[]} messages
 * @param {number} start
 * @param {Map<string, { callId: string | undefined, tool: string, args: Record<string, unknown>, why?: string }>} byCallId
 * @param {number} maxTextChars
 * @returns {Array<{ callId: string | undefined, tool: string, status: string, result: Record<string, unknown> }>}
 */
function collectToolResults(messages, start, byCallId, maxTextChars) {
  const results = [];
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (isAssistantToolDecision(message)) break;
    if (!isToolMessage(message)) continue;
    const callId = nonEmptyText(message.tool_call_id);
    if (!callId || !byCallId.has(callId)) continue;
    const decision = byCallId.get(callId);
    const payload = normalizeToolResultPayload(message.content, maxTextChars);
    results.push({
      callId,
      tool: decision ? decision.tool : 'unknown',
      status: payload.status,
      result: payload.result,
    });
  }
  return results;
}

/**
 * @param {{ runId?: string, messages?: unknown[], maxTextChars?: number }} input
 * @returns {Record<string, unknown>[]}
 */
export function buildDecisionTraceFromMessages(input = {}) {
  const runId = normalizeRunId(input.runId);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const maxTextChars = Math.max(80, Math.floor(Number(input.maxTextChars) || DEFAULT_MAX_TEXT_CHARS));
  const entries = [];
  let step = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isAssistantToolDecision(message)) continue;
    step += 1;
    const normalized = normalizeToolDecisions({ modelMessage: message }, maxTextChars);
    const byCallId = new Map(normalized.decisions
      .filter((decision) => decision.callId)
      .map((decision) => [String(decision.callId), decision]));
    entries.push({
      schemaVersion: 1,
      runId,
      kind: 'decision_step',
      step,
      modelSaw: {
        messages: normalizeMessages(messages.slice(0, index), maxTextChars),
        tools: [],
      },
      decisions: normalized.decisions,
      results: collectToolResults(messages, index + 1, byCallId, maxTextChars),
    });
  }
  return entries.map((entry) => /** @type {Record<string, unknown>} */ (jsonClone(entry)));
}
