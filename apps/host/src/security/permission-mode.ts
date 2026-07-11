// Agent 权限模式(host · L0 安全层)
// ---------------------------------------------------------------------------
// 职责:把新版 permissionMode 与旧版 planMode/autoApprove 请求归一化为单一安全事实源。
// 未知显式值一律 fail-closed 为 manual；guarded_auto 只授权审批门自动放行低风险操作。
export type PermissionMode = 'plan' | 'manual' | 'guarded_auto';

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolvePermissionMode(value: unknown): PermissionMode {
  const source = recordOrEmpty(value);
  if (Object.hasOwn(source, 'permissionMode')) {
    if (source.permissionMode === 'plan') return 'plan';
    if (source.permissionMode === 'guarded_auto') return 'guarded_auto';
    return 'manual';
  }
  if (source.planMode === true) return 'plan';
  return source.autoApprove === true ? 'guarded_auto' : 'manual';
}

export function shouldAutoApproveLowRisk(mode: PermissionMode): boolean {
  return mode === 'guarded_auto';
}
