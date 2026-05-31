// 运行事件总线(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:进程内的运行时间线事件总线 + SSE 辅助。每个 run 有单调 seq,事件形如 { seq, ts, type, ... };
//       每 run 一个有界环形缓冲,支持断线/迟到的 SSE 客户端用 Last-Event-ID 重放近期事件。
// 可扩展:这是 EventBus 端口的 A 阶段适配器,B 阶段可换 NATS/Redis 而 publish/subscribe/replay 契约不变。
// 依赖:无。导出:运行事件总线工厂与 SSE 辅助。
// In-process event bus for run timelines + SSE helpers. Zero-dep.
//
// Each run has a monotonic seq counter. Events carry { seq, ts, type, ...payload }.
// A bounded ring buffer per run lets a late or reconnecting SSE client replay
// recent events via Last-Event-ID. Persisted events[] on the run record cover
// replay across restarts.
//
// Scale-readiness note: this is the Phase A adapter for the EventBus port.
// Phase B swaps to NATS/Redis pub-sub; the publish/subscribe/replay surface and
// the seq-as-Last-Event-ID contract stay the same.

const DEFAULT_BUFFER = 500;

export type RunEventPublishInput = { type?: unknown; [key: string]: unknown };
export type RunEventSeedInput = { seq?: unknown; [key: string]: unknown };
export type RunEvent = { seq: number; ts: string; type: string; [key: string]: unknown };
export type RunEventHandler = (event: RunEvent) => void;
export type RunEventBusOptions = { bufferSize?: number };

export class RunEventBus {
  readonly bufferSize: number;
  readonly subscribers: Map<string, Set<RunEventHandler>>;
  readonly buffers: Map<string, RunEvent[]>;
  readonly seq: Map<string, number>;

  constructor({ bufferSize = DEFAULT_BUFFER }: RunEventBusOptions = {}) {
    this.bufferSize = Math.max(10, Number(bufferSize) || DEFAULT_BUFFER);
    this.subscribers = new Map(); // runId -> Set<handler>
    this.buffers = new Map(); // runId -> [{seq, ts, type, ...}]
    this.seq = new Map(); // runId -> number
  }

  private _nextSeq(runId: string): number {
    const next = (this.seq.get(runId) || 0) + 1;
    this.seq.set(runId, next);
    return next;
  }

  publish(runId: string, event: RunEventPublishInput): RunEvent {
    if (!runId) {
      throw new Error('RunEventBus.publish: runId required');
    }
    if (!event || typeof event.type !== 'string') {
      throw new Error('RunEventBus.publish: event.type required');
    }
    const seq = this._nextSeq(runId);
    const enriched = {
      seq,
      ts: new Date().toISOString(),
      ...event,
    } as RunEvent;
    let buffer = this.buffers.get(runId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(runId, buffer);
    }
    buffer.push(enriched);
    if (buffer.length > this.bufferSize) {
      buffer.splice(0, buffer.length - this.bufferSize);
    }
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const handler of subs) {
        try {
          handler(enriched);
        } catch {
          // a broken subscriber must never break the publisher
        }
      }
    }
    return enriched;
  }

  // Seed the bus from persisted events (e.g. on SSE connect after restart)
  // so subsequent live events keep a monotonic seq above the persisted max.
  seed(runId: string, events: RunEventSeedInput[] = []): void {
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    const maxSeq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    if (maxSeq > (this.seq.get(runId) || 0)) {
      this.seq.set(runId, maxSeq);
    }
  }

  subscribe(runId: string, handler: RunEventHandler): () => void {
    if (typeof handler !== 'function') {
      throw new Error('RunEventBus.subscribe: handler must be a function');
    }
    let subs = this.subscribers.get(runId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(runId, subs);
    }
    subs.add(handler);
    return () => {
      const current = this.subscribers.get(runId);
      if (current) {
        current.delete(handler);
        if (current.size === 0) {
          this.subscribers.delete(runId);
        }
      }
    };
  }

  replay(runId: string, afterSeq = 0): RunEvent[] {
    const buffer = this.buffers.get(runId) || [];
    const floor = Number(afterSeq) || 0;
    return buffer.filter((event) => event.seq > floor);
  }

  subscriberCount(runId: string): number {
    const subs = this.subscribers.get(runId);
    return subs ? subs.size : 0;
  }
}

// Format a single SSE frame. `id:` carries the seq so the browser's
// EventSource sends it back as Last-Event-ID on reconnect.
export function formatSseFrame(event: { seq?: unknown; type?: unknown; [key: string]: unknown }): string {
  const lines: string[] = [];
  if (event.seq != null) {
    lines.push(`id: ${event.seq}`);
  }
  if (event.type) {
    lines.push(`event: ${event.type}`);
  }
  const data = JSON.stringify(event);
  lines.push(`data: ${data}`);
  return `${lines.join('\n')}\n\n`;
}

export function parseLastEventId(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
