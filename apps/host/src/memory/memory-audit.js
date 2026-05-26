// @ts-check

import { AuditEventBus, createJsonlAuditSubscriber } from '../storage/audit-events.js';
import { auditPath } from './memory-utils.js';

/**
 * @typedef {{ auditBus?: AuditEventBus } & Record<string, unknown>} MemoryAuditContext
 */

/** @type {Map<string, AuditEventBus>} */
const defaultAuditBuses = new Map();

/**
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
 * @param {unknown} trustedRoot
 * @returns {Promise<void>}
 */
export async function flushMemoryAuditEvents(trustedRoot) {
  const bus = defaultAuditBuses.get(auditPath(trustedRoot));
  if (bus) {
    await bus.flush();
  }
}
