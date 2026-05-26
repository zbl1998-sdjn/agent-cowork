// @ts-check
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

/**
 * @typedef {{ type?: unknown, [key: string]: unknown }} RunEventPublishInput
 * @typedef {{ seq?: unknown, [key: string]: unknown }} RunEventSeedInput
 * @typedef {{ seq: number, ts: string, type: string, [key: string]: unknown }} RunEvent
 * @typedef {(event: RunEvent) => void} RunEventHandler
 * @typedef {{ bufferSize?: number }} RunEventBusOptions
 */

export class RunEventBus {
  /** @param {RunEventBusOptions} [options] */
  constructor({ bufferSize = DEFAULT_BUFFER } = {}) {
    this.bufferSize = Math.max(10, Number(bufferSize) || DEFAULT_BUFFER);
    /** @type {Map<string, Set<RunEventHandler>>} */
    this.subscribers = new Map(); // runId -> Set<handler>
    /** @type {Map<string, RunEvent[]>} */
    this.buffers = new Map(); // runId -> [{seq, ts, type, ...}]
    /** @type {Map<string, number>} */
    this.seq = new Map(); // runId -> number
  }

  /**
   * @param {string} runId
   * @returns {number}
   */
  _nextSeq(runId) {
    const next = (this.seq.get(runId) || 0) + 1;
    this.seq.set(runId, next);
    return next;
  }

  /**
   * @param {string} runId
   * @param {RunEventPublishInput} event
   * @returns {RunEvent}
   */
  publish(runId, event) {
    if (!runId) {
      throw new Error('RunEventBus.publish: runId required');
    }
    if (!event || typeof event.type !== 'string') {
      throw new Error('RunEventBus.publish: event.type required');
    }
    const seq = this._nextSeq(runId);
    const enriched = /** @type {RunEvent} */ ({
      seq,
      ts: new Date().toISOString(),
      ...event,
    });
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
  /**
   * @param {string} runId
   * @param {RunEventSeedInput[]} [events]
   */
  seed(runId, events = []) {
    if (!Array.isArray(events) || events.length === 0) {
      return;
    }
    const maxSeq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    if (maxSeq > (this.seq.get(runId) || 0)) {
      this.seq.set(runId, maxSeq);
    }
  }

  /**
   * @param {string} runId
   * @param {RunEventHandler} handler
   * @returns {() => void}
   */
  subscribe(runId, handler) {
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

  /**
   * @param {string} runId
   * @param {number} [afterSeq]
   * @returns {RunEvent[]}
   */
  replay(runId, afterSeq = 0) {
    const buffer = this.buffers.get(runId) || [];
    const floor = Number(afterSeq) || 0;
    return buffer.filter((event) => event.seq > floor);
  }

  /**
   * @param {string} runId
   * @returns {number}
   */
  subscriberCount(runId) {
    const subs = this.subscribers.get(runId);
    return subs ? subs.size : 0;
  }
}

// Format a single SSE frame. `id:` carries the seq so the browser's
// EventSource sends it back as Last-Event-ID on reconnect.
/**
 * @param {{ seq?: unknown, type?: unknown, [key: string]: unknown }} event
 * @returns {string}
 */
export function formatSseFrame(event) {
  const lines = [];
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

/**
 * @param {unknown} value
 * @returns {number}
 */
export function parseLastEventId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
