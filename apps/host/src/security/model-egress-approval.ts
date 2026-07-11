// 模型出站审批 capability 状态(host · L0 security)
// ---------------------------------------------------------------------------
// 职责:在真实 receipt 消费器落地前统一声明 fail-closed 能力边界，避免把
// needs_approval、裸布尔值或预览记录误当成已经获得授权。
export const MODEL_EGRESS_APPROVAL_CAPABILITY = Object.freeze({
  status: 'unavailable' as const,
  reasonCode: 'model_egress_approval_receipt_unavailable',
  requiredBindings: Object.freeze([
    'scope',
    'ttl',
    'single_use',
    'endpoint',
    'content',
  ] as const),
});
