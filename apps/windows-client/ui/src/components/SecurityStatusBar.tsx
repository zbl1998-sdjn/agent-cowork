// SecurityStatusBar(UI components):显示本地安全模式、模型出口和今日出站字节数。
import type { SecurityStatus } from '../lib/types/security';

export type { SecurityStatus } from '../lib/types/security';

function formatBytes(value: unknown): string {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function modeLabel(mode: string): string {
  const labels: Record<string, string> = {
    local_demo: '本地演示',
    local_strict: '本地严格',
    enterprise_local: '企业本地',
    air_gap: '离线隔离',
    controlled_hybrid: '受控混合',
  };
  return labels[mode] || mode || '未知';
}

export function SecurityStatusBar({ status }: { status: SecurityStatus | null }) {
  if (!status) return null;
  const provider = status.model?.provider || '未配置';
  const model = status.model?.model || '';
  const egressBytes = formatBytes(status.egress?.todayContentBytes);
  const cloudCalls = status.egress?.todayExternalModelCalls || 0;
  const deniedCount = status.egress?.deniedCount || 0;
  return (
    <div className="security-status-bar" role="status" aria-label="本地安全状态">
      <span className="security-pill">{modeLabel(status.securityMode)}</span>
      <span>模型 {provider}{model ? ` / ${model}` : ''}</span>
      <span>外发 {egressBytes}</span>
      {(cloudCalls > 0 || deniedCount > 0) && <span>云模型 {cloudCalls} 次 / 阻断 {deniedCount}</span>}
    </div>
  );
}
