import path from 'node:path';
import { AuditEventBus, createJsonlAuditSubscriber } from './audit-events.js';

// A memoized, JSONL-backed audit bus for agent *action decisions*: approvals,
// auto-approvals, rejections, plan-mode gating, and mutating-tool execution.
// Kept separate from the memory audit so a security review has a dedicated,
// append-only trail of every side-effecting decision the agent made.

const ACTION_AUDIT_FILE = path.join('.AgentCowork', 'audit', 'actions.jsonl');
const buses = new Map();

export function actionAuditPath(trustedRoot) {
  return path.join(path.resolve(trustedRoot || '.'), ACTION_AUDIT_FILE);
}

export function getActionAuditBus(trustedRoot) {
  const file = actionAuditPath(trustedRoot);
  let bus = buses.get(file);
  if (!bus) {
    bus = new AuditEventBus();
    bus.subscribe(createJsonlAuditSubscriber(file));
    buses.set(file, bus);
  }
  return bus;
}
