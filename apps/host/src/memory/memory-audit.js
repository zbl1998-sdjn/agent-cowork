// @ts-check
// 记忆写操作的审计事件出口(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:为每个 trustedRoot 维护一条按需创建的审计总线,把记忆写事件发布到对应的
//       JSONL 审计文件;并提供 flush 在收尾时落盘。注:按既有架构本模块直接取
//       storage 层审计设施,属正常豁免。
// 依赖:storage/audit-events、同目录 memory-utils(auditPath)。
// 导出:appendAuditEvent、flushMemoryAuditEvents。

import { AuditEventBus, createJsonlAuditSubscriber } from '../storage/audit-events.js';
import { auditPath } from './memory-utils.js';

/**
 * @typedef {{ auditBus?: AuditEventBus } & Record<string, unknown>} MemoryAuditContext
 */

// 按审计文件路径缓存总线,使同一 root 复用一条流而非每次新建订阅者。
/** @type {Map<string, AuditEventBus>} */
const defaultAuditBuses = new Map();

/**
 * 取(或惰性创建)某 trustedRoot 对应的默认审计总线。
 * @param {unknown} trustedRoot
 * @returns {AuditEventBus}
 */
function getDefaultAuditBus(trustedRoot) {
  const audit = auditPath(trustedRoot);
  let bus = defaultAuditBuses.get(audit);
  if (!bus) {
    bus = new AuditEventBus();
    bus.subscribe(createJsonlAuditSubscriber(audit));
    defaultAuditBuses.set(audit, bus);
  }
  return bus;
}

/**
 * 发布一条记忆审计事件:优先用 context 注入的总线,否则用该 root 的默认总线;返回审计文件路径。
 * @param {unknown} trustedRoot
 * @param {Record<string, unknown>} event
 * @param {MemoryAuditContext} [context]
 * @returns {string}
 */
export function appendAuditEvent(trustedRoot, event, context = {}) {
  const audit = auditPath(trustedRoot);
  const bus = context.auditBus || getDefaultAuditBus(trustedRoot);
  bus.publish(event);
  return audit;
}

/**
 * 等待该 root 的默认总线把缓冲事件全部落盘(无总线则为 no-op),用于收尾。
 * @param {unknown} trustedRoot
 * @returns {Promise<void>}
 */
export async function flushMemoryAuditEvents(trustedRoot) {
  const bus = defaultAuditBuses.get(auditPath(trustedRoot));
  if (bus) {
    await bus.flush();
  }
}
