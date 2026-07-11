// 待确认操作(UI · lib):为必须收到 Host 确认后才能更新界面的动作提供纯函数防重入与失败关闭。
import type { AssistantMessage } from './app-types';

export type AssistantPendingRequestField = 'approval' | 'plan' | 'question';

export function clearAcknowledgedAssistantRequest(
  message: AssistantMessage,
  field: AssistantPendingRequestField,
  acknowledgedId: string,
  patch: Partial<AssistantMessage> = {},
): AssistantMessage {
  if (message[field]?.id !== acknowledgedId) return message;
  const { status, ...safePatch } = patch;
  return {
    ...message,
    ...safePatch,
    ...(status !== undefined && message.status === 'awaiting_approval' ? { status } : {}),
    [field]: undefined,
  };
}

export function setPendingApprovalError(
  message: AssistantMessage,
  approvalId: string,
  error: string | undefined,
): AssistantMessage {
  if (message.approval?.id !== approvalId) return message;
  return { ...message, approval: { ...message.approval, error } };
}

export interface PendingActionGate {
  isPending: () => boolean;
  run: (work: () => Promise<void>) => Promise<boolean>;
}

export interface PendingApprovalRef {
  messageId: string;
  id: string;
  sessionReusable: boolean;
}

export function partitionApprovalAcknowledgements(
  pendingApprovals: PendingApprovalRef[],
  result: { ok?: boolean; resolved?: number; results: Array<{ id: string; ok: boolean }> },
): { acknowledged: PendingApprovalRef[]; failed: PendingApprovalRef[] } {
  const acknowledgedIds = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
  return pendingApprovals.reduce<{ acknowledged: PendingApprovalRef[]; failed: PendingApprovalRef[] }>((partitioned, item) => {
    partitioned[acknowledgedIds.has(item.id) ? 'acknowledged' : 'failed'].push(item);
    return partitioned;
  }, { acknowledged: [], failed: [] });
}

export function createPendingActionGate(): PendingActionGate {
  let pending = false;
  return {
    isPending: () => pending,
    run: async (work) => {
      if (pending) return false;
      pending = true;
      try {
        await work();
        return true;
      } finally {
        pending = false;
      }
    },
  };
}

export async function requireAcknowledgement(
  request: () => Promise<boolean>,
  onAcknowledged: () => void,
): Promise<void> {
  if (!await request()) {
    throw new Error('本地服务未确认该操作，审批卡已保留，请重试');
  }
  onAcknowledged();
}
