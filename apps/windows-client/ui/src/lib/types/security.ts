// 安全状态视图模型(UI · lib/types):host 安全状态接口在 UI 内的共享契约。
export interface SecurityStatus {
  securityMode: string;
  model?: {
    provider?: string;
    model?: string;
    providerClass?: string;
    decision?: string;
  };
  egress?: {
    todayContentBytes?: number;
    todayExternalModelCalls?: number;
    deniedCount?: number;
    needsApprovalCount?: number;
  };
}
