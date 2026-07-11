// 运行事件总线(host · L0 基础层 · util)
// ---------------------------------------------------------------------------
// 职责:进程内的运行时间线事件总线 + SSE 辅助。每个 run 有单调 seq,事件形如 { seq, ts, type, ... };
//       每 run 一个有界环形缓冲,支持断线/迟到的 SSE 客户端用 Last-Event-ID 重放近期事件。
// 可扩展:这是 EventBus 端口的 A 阶段适配器,B 阶段可换 NATS/Redis 而 publish/subscribe/replay 契约不变。
// 依赖:L0 identity-scope。导出:运行事件总线工厂与 SSE 辅助。

import {
  identityScopeTupleKey,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

const DEFAULT_BUFFER = 500;

export type RunEventPublishInput = { type?: unknown; [key: string]: unknown };
export type RunEventSeedInput = { seq?: unknown; [key: string]: unknown };
export type RunEvent = { seq: number; ts: string; type: string; [key: string]: unknown };
export type RunEventHandler = (event: RunEvent) => void;
export type RunEventBusOptions = { bufferSize?: number };
export type RunEventScope = { tenantId?: unknown; userId?: unknown };

function scopedRunKey(runId: string, scope: RunEventScope | undefined): string {
  const owner = requireIdentityScopeFrom(scope, {
    allowLocalDefault: true,
    label: 'RunEventBus scope',
  });
  return identityScopeTupleKey(owner, runId);
}

export class RunEventBus {
  readonly bufferSize: number;
  readonly subscribers: Map<string, Set<RunEventHandler>>;
  readonly buffers: Map<string, RunEvent[]>;
  readonly seq: Map<string, number>;

  constructor({ bufferSize = DEFAULT_BUFFER }: RunEventBusOptions = {}) {
    this.bufferSize = Math.max(10, Number(bufferSize) || DEFAULT_BUFFER);
    this.subscribers = new Map(); // runId 到订阅回调集合。
    this.buffers = new Map(); // runId 到近期事件环形缓冲。
    this.seq = new Map(); // runId 到当前最大 seq。
  }

  private _nextSeq(key: string): number {
    const next = (this.seq.get(key) || 0) + 1;
    this.seq.set(key, next);
    return next;
  }

  publish(runId: string, event: RunEventPublishInput, scope?: RunEventScope): RunEvent {
    if (!runId) {
      throw new Error('RunEventBus.publish: runId required');
    }
    if (!event || typeof event.type !== 'string') {
      throw new Error('RunEventBus.publish: event.type required');
    }
    const key = scopedRunKey(runId, scope);
    const seq = this._nextSeq(key);
    const enriched = {
      seq,
      ts: new Date().toISOString(),
      ...event,
    } as RunEvent;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = [];
      this.buffers.set(key, buffer);
    }
    buffer.push(enriched);
    if (buffer.length > this.bufferSize) {
      buffer.splice(0, buffer.length - this.bufferSize);
    }
    const subs = this.subscribers.get(key);
    if (subs) {
      for (const handler of subs) {
        try {
          handler(enriched);
        } catch {
          // 单个订阅者异常不能影响发布者与其他订阅者。
        }
      }
    }
    return enriched;
  }

  // 用已持久化事件播种 seq,保证重启后新 live 事件仍单调递增。
  seed(runId: string, events: RunEventSeedInput[] = [], scope?: RunEventScope): void {
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    const key = scopedRunKey(runId, scope);
    const maxSeq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    if (maxSeq > (this.seq.get(key) || 0)) {
      this.seq.set(key, maxSeq);
    }
  }

  subscribe(runId: string, handler: RunEventHandler, scope?: RunEventScope): () => void {
    if (typeof handler !== 'function') {
      throw new Error('RunEventBus.subscribe: handler must be a function');
    }
    const key = scopedRunKey(runId, scope);
    let subs = this.subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(key, subs);
    }
    subs.add(handler);
    return () => {
      const current = this.subscribers.get(key);
      if (current) {
        current.delete(handler);
        if (current.size === 0) {
          this.subscribers.delete(key);
        }
      }
    };
  }

  replay(runId: string, afterSeq = 0, scope?: RunEventScope): RunEvent[] {
    const buffer = this.buffers.get(scopedRunKey(runId, scope)) || [];
    const floor = Number(afterSeq) || 0;
    return buffer.filter((event) => event.seq > floor);
  }

  subscriberCount(runId: string, scope?: RunEventScope): number {
    const subs = this.subscribers.get(scopedRunKey(runId, scope));
    return subs ? subs.size : 0;
  }
}

// 格式化单帧 SSE;id 携带 seq,浏览器重连时会作为 Last-Event-ID 回传。
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
