// @ts-check
// 审计事件总线与 JSONL 落盘订阅者(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:提供进程内审计事件发布/订阅总线,统一补齐 ts/trace/tenant/user 字段,
//       异步分发并聚合订阅者异常;附带把事件追加写入 JSONL 文件的订阅者工厂。
// 依赖:同层 jsonl-writer(L1)。
// 导出:AuditEventBus(类) · createJsonlAuditSubscriber(filePath, opts)(工厂)。
import { JsonlWriter } from './jsonl-writer.js';

/**
 * @typedef {Record<string, unknown>} AuditEvent
 * @typedef {(event: AuditEvent) => unknown | Promise<unknown>} AuditSubscriber
 * @typedef {(error: Error, event: AuditEvent) => void} AuditErrorHandler
 */

/**
 * 规范化审计事件:补齐时间戳,并同时输出 snake_case 与 camelCase 两种命名的 trace/tenant/user。
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

/** 进程内审计事件总线:发布事件并异步分发给订阅者,聚合失败供 flush 抛出。 */
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
   * 注册订阅者,返回退订函数。
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
   * 发布事件:规范化后非阻塞地分发给所有订阅者,返回补齐后的事件。
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
   * 等待所有在途分发完成;若有订阅者抛错则以 AggregateError 汇总抛出。
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
 * 创建一个把审计事件追加写入 JSONL 文件的订阅者(可挂到 AuditEventBus.subscribe)。
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
