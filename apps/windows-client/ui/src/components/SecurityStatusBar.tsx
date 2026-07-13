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

function protectionLabel(mode: string, providerClass?: string): string {
  if (mode === 'air_gap') return '完全离线';
  if (providerClass === 'local') return '仅本地处理';
  if (providerClass === 'customer_gateway') return '使用企业模型服务';
  if (providerClass === 'external_provider') return '使用云端模型';
  return mode === 'local_strict' || mode === 'enterprise_local' || mode === 'local_demo'
    ? '仅本地处理'
    : '数据边界待确认';
}

function activityLabel(contentBytes: unknown, externalModelCalls: number): string {
  const egressBytes = formatBytes(contentBytes);
  if (egressBytes === '0 B' && externalModelCalls === 0) return '今天未记录外发内容';
  if (egressBytes === '0 B') return `今天已调用外部模型 ${externalModelCalls} 次，未记录外发内容`;
  const calls = externalModelCalls > 0 ? ` · 外部模型 ${externalModelCalls} 次` : '';
  return `今天已记录外发内容 ${egressBytes}${calls}`;
}

export function SecurityStatusBar({ status }: { status: SecurityStatus | null }) {
  if (!status) return null;
  const provider = status.model?.provider || '未配置';
  const model = status.model?.model || '';
  const cloudCalls = status.egress?.todayExternalModelCalls || 0;
  const deniedCount = status.egress?.deniedCount || 0;
  return (
    <div className="security-status-bar" role="status" aria-live="polite" aria-label="数据保护状态">
      <span className="security-pill">{protectionLabel(status.securityMode, status.model?.providerClass)}</span>
      <span className="security-summary">
        {activityLabel(status.egress?.todayContentBytes, cloudCalls)}
      </span>
      <details className="security-details">
        <summary>技术详情</summary>
        <div>
          <span>保护模式：{modeLabel(status.securityMode)}</span>
          <span>使用模型：{provider}{model ? ` / ${model}` : ''}</span>
          <span>外部模型调用：{cloudCalls} 次</span>
          <span>已阻止：{deniedCount} 次</span>
        </div>
      </details>
    </div>
  );
}
