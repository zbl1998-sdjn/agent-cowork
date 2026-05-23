import { JsonlWriter } from '../storage/jsonl-writer.js';

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
  constructor({ now = () => new Date(), onError = null } = {}) {
    this.now = now;
    this.onError = onError;
    this.subscribers = new Set();
    this.pending = new Set();
    this.errors = [];
  }

  subscribe(handler) {
    if (typeof handler !== 'function') {
      throw new Error('AuditEventBus.subscribe: handler must be a function');
    }
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

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

// Persist audit events to a JSONL file WITH size-based rotation, so actions.jsonl
// / memory.jsonl can't grow without bound. `opts` ({ maxBytes, maxFiles }) is
// forwarded to JsonlWriter (env-tunable defaults apply otherwise).
export function createJsonlAuditSubscriber(filePath, opts = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('audit filePath is required');
  }
  const writer = new JsonlWriter(filePath, opts);
  return (event) => writer.append(event);
}
