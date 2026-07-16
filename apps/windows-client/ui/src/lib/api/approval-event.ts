// 审批事件归一化(UI · 传输层 · lib/api):把 Host SSE 审批元数据收敛为稳定的 UI 契约。
import type { SsePayload } from './sse';

export interface ApprovalRequestMeta {
  risk?: string | undefined;
  preview?: unknown;
  sessionReusable: boolean;
  workspacePersistable: boolean;
}

export function approvalRequestMeta(data: SsePayload): ApprovalRequestMeta {
  return {
    risk: typeof data.risk === 'string' ? data.risk : undefined,
    preview: data.preview,
    sessionReusable: data.sessionReusable === true,
    workspacePersistable: data.workspacePersistable === true,
  };
}
