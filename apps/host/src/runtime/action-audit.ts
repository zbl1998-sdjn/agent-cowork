// 动作审计(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:对 Agent「动作决策」(审批/自动放行/拒绝/计划门禁/变更类工具执行)做带缓存的 JSONL 审计落盘,
//       形成不可抵赖的操作留痕。依赖:node:path + 同层 audit-events。导出:动作审计总线。
import path from 'node:path';
import { AuditEventBus, createJsonlAuditSubscriber } from './audit-events.js';

const ACTION_AUDIT_FILE = path.join('.AgentCowork', 'audit', 'actions.jsonl');
const buses = new Map<string, AuditEventBus>();

export function actionAuditPath(trustedRoot: string | null | undefined): string {
  return path.join(path.resolve(trustedRoot || '.'), ACTION_AUDIT_FILE);
}

export function getActionAuditBus(trustedRoot: string | null | undefined): AuditEventBus {
  const file = actionAuditPath(trustedRoot);
  let bus = buses.get(file);
  if (!bus) {
    bus = new AuditEventBus();
    bus.subscribe(createJsonlAuditSubscriber(file));
    buses.set(file, bus);
  }
  return bus;
}
