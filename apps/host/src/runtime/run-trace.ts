// 运行追踪(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把一次运行的完整「轨迹」(消息、工具决策、工具结果)归一化、清洗与脱敏成可展示/可存储的 trace,
//       供回放与调试。文本按上限截断,敏感内容经 sanitizer 处理。
// 依赖:同层 run-trace-normalizers / run-trace-sanitizers。导出:构建运行 trace 的函数。
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

export type RunEventsLike = {
  publish(runId: string, event: Record<string, unknown>): unknown;
};

export type RunTraceOptions = {
  runId?: string;
  runEvents?: RunEventsLike | null;
  now?: () => Date | string;
  maxTextChars?: number;
};

type ReplayOptions = { after?: number };
type ToolDecision = ReturnType<typeof normalizeToolDecisions>['decisions'][number];

type ToolResultTrace = {
  callId: string;
  tool: string;
  status: string;
  result: Record<string, unknown>;
};

export class RunTrace {
  readonly runId: string;
  readonly runEvents: RunEventsLike | null;
  readonly now: () => Date | string;
  readonly maxTextChars: number;
  readonly entries: Record<string, unknown>[];
  traceSeq: number;

  constructor({
    runId,
    runEvents = null,
    now = () => new Date(),
    maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  }: RunTraceOptions = {}) {
    this.runId = normalizeRunId(runId);
    this.runEvents = runEvents;
    this.now = now;
    this.maxTextChars = Math.max(80, Math.floor(Number(maxTextChars) || DEFAULT_MAX_TEXT_CHARS));
    this.entries = [];
    this.traceSeq = 0;
  }

  append(event: Record<string, unknown>): Record<string, unknown> {
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
    const cloned = jsonClone(entry) as Record<string, unknown>;
    this.entries.push(cloned);
    if (this.runEvents && typeof this.runEvents.publish === 'function') {
      this.runEvents.publish(this.runId, { type: 'run_trace', trace: cloned });
    }
    return jsonClone(cloned) as Record<string, unknown>;
  }

  replay({ after = 0 }: ReplayOptions = {}): Record<string, unknown>[] {
    const floor = Number(after) || 0;
    return this.entries
      .filter((entry) => Number(entry.traceSeq) > floor)
      .map((entry) => jsonClone(entry) as Record<string, unknown>);
  }
}

export function createRunTrace(options: RunTraceOptions = {}): RunTrace {
  return new RunTrace(options);
}

export function replayRunTraceEvents(events: unknown[], { after = 0 }: ReplayOptions = {}): Record<string, unknown>[] {
  if (!Array.isArray(events)) return [];
  const floor = Number(after) || 0;
  return events
    .filter(isRecord)
    .filter((event) => event.type === 'run_trace')
    .map((event) => (isRecord(event.trace) ? event.trace : event.entry))
    .filter(isRecord)
    .filter((entry) => Number(entry.traceSeq) > floor)
    .sort((a, b) => (Number(a.traceSeq) || Number(a.seq) || 0) - (Number(b.traceSeq) || Number(b.seq) || 0))
    .map((entry) => jsonClone(entry) as Record<string, unknown>);
}

function isAssistantToolDecision(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function isToolMessage(message: unknown): message is Record<string, unknown> {
  return isRecord(message) && message.role === 'tool';
}

function collectToolResults(
  messages: unknown[],
  start: number,
  byCallId: Map<string, ToolDecision>,
  maxTextChars: number,
): ToolResultTrace[] {
  const results: ToolResultTrace[] = [];
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

export function buildDecisionTraceFromMessages(input: {
  runId?: string;
  messages?: unknown[];
  maxTextChars?: number;
} = {}): Record<string, unknown>[] {
  const runId = normalizeRunId(input.runId);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const maxTextChars = Math.max(80, Math.floor(Number(input.maxTextChars) || DEFAULT_MAX_TEXT_CHARS));
  const entries: Record<string, unknown>[] = [];
  let step = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!isAssistantToolDecision(message)) continue;
    step += 1;
    const normalized = normalizeToolDecisions({ modelMessage: message }, maxTextChars);
    const byCallId = new Map(normalized.decisions
      .filter((decision) => decision.callId)
      .map((decision): [string, ToolDecision] => [String(decision.callId), decision]));
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
  return entries.map((entry) => jsonClone(entry) as Record<string, unknown>);
}
