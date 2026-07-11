// Agent 流断连清理(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:释放断连运行的审批等待者,并把同步/异步清理失败统一脱敏上报。
import { redactText } from '../security/redaction.js';
import type { ApprovalRegistry, RequestContext } from '../kimi/agent/approval-gate.js';

export type DisconnectApprovalRegistry = ApprovalRegistry & {
  cancelByRun?: (runId: string, context?: RequestContext | null) => unknown;
};

export function cancelApprovalsForDisconnectedRun(
  approvals: DisconnectApprovalRegistry | null | undefined,
  runId: string,
  context: RequestContext,
  reportError: (message: string) => void = (message) => console.error('[agent-stream] approval cleanup failed:', message),
): void {
  if (!approvals || typeof approvals.cancelByRun !== 'function') return;
  const report = (error: unknown): void => {
    const raw = error instanceof Error ? error.message : String(error);
    reportError(redactText(raw) || 'unknown approval cleanup failure');
  };
  try {
    const result = approvals.cancelByRun(runId, context);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(report);
    }
  } catch (error) {
    report(error);
  }
}
