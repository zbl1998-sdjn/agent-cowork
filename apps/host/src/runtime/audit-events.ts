// 审计事件(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:运行时层对审计事件的「再导出」门面——实际实现位于 storage/audit-events(jsonl 落盘订阅者),
//       这里转出供运行时各处统一引用。导出:AuditEventBus / createJsonlAuditSubscriber / hash-chain helpers。
export {
  AuditEventBus,
  createJsonlAuditSubscriber,
  verifyAuditHashChain,
  readLastAuditHash,
} from '../storage/audit-events.js';
