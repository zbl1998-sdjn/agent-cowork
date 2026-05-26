// @ts-check
import { JsonlWriter } from './jsonl-writer.js';

/**
 * @typedef {Record<string, unknown>} AuditEvent
 * @typedef {(event: AuditEvent) => unknown | Promise<unknown>} AuditSubscriber
 * @typedef {(error: Error, event: AuditEvent) => void} AuditErrorHandler
 */

/**
 * @param {AuditEvent} event
 * @param {() => Date} [now]
 * @returns {AuditEvent}
 */
function normaliseAuditEvent(event, now = () => new Date()) {
  const traceId = event.trace_id || event.traceId || null;
  const tenantId = event.tenant_id || event.tenantId || null;
  const userId = event.user_id || event.userId || null;
  return {
    ts: event.ts || now().toISOString(),
    ...event,
    trace_id: traceId,
    tenant_id: tenantId,
    user_id: userId,
    traceId,
    tenantId,
    userId,
  };
}

export class AuditEventBus {
  /**
   * @param {{ now?: () => Date, onError?: AuditErrorHandler | null }} [options]
   */
  constructor({ now = () => new Date(), onError = null } = {}) {
    /** @type {() => Date} */
    this.now = now;
    /** @type {AuditErrorHandler | null} */
    this.onError = onError;
    /** @type {Set<AuditSubscriber>} */
    this.subscribers = new Set();
    /** @type {Set<Promise<unknown>>} */
    this.pending = new Set();
    /** @type {Error[]} */
    this.errors = [];
  }

  /**
   * @param {AuditSubscriber} handler
   * @returns {() => void}
   */
  subscribe(handler) {
    if (typeof handler !== 'function') {
      throw new Error('AuditEventBus.subscribe: handler must be a function');
    }
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * @param {AuditEvent} event
   * @returns {AuditEvent}
   */
  publish(event) {
    const enriched = normaliseAuditEvent(event, this.now);
    for (const handler of this.subscribers) {
      const pending = Promise.resolve()
        .then(() => handler(enriched))
        .catch((error) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.errors.push(failure);
          if (typeof this.onError === 'function') {
            try {
              this.onError(failure, enriched);
            } catch (onErrorFailure) {
              this.errors.push(onErrorFailure instanceof Error ? onErrorFailure : new Error(String(onErrorFailure)));
            }
          }
        })
        .finally(() => {
          this.pending.delete(pending);
        });
      this.pending.add(pending);
    }
    return enriched;
  }

  /**
   * @returns {Promise<void>}
   */
  async flush() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
    if (this.errors.length > 0) {
      const errors = this.errors.splice(0);
      throw new AggregateError(errors, 'AuditEventBus subscriber failed');
    }
  }
}

/**
 * @param {string} filePath
 * @param {import('./jsonl-writer.js').JsonlWriterOptions} [opts]
 * @returns {AuditSubscriber}
 */
export function createJsonlAuditSubscriber(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('audit filePath is required');
  }
  const writer = new JsonlWriter(filePath, opts);
  return (event) => writer.append(event);
}
