import { AuditEventBus, createJsonlAuditSubscriber } from '../storage/audit-events.js';
import { auditPath } from './memory-utils.js';

const defaultAuditBuses = new Map();

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

export function appendAuditEvent(trustedRoot, event, context = {}) {
  const audit = auditPath(trustedRoot);
  const bus = context.auditBus || getDefaultAuditBus(trustedRoot);
  bus.publish(event);
  return audit;
}

export async function flushMemoryAuditEvents(trustedRoot) {
  const bus = defaultAuditBuses.get(auditPath(trustedRoot));
  if (bus) {
    await bus.flush();
  }
}
