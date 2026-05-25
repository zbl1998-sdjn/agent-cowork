import type { RuntimeDependency, RuntimeDependencyResponse } from './api/runtimeDependencies';

export type RuntimeDependencySeverity = 'ok' | 'warn' | 'error' | 'muted';

export interface RuntimeDependencyViewItem extends RuntimeDependency {
  statusLabel: string;
  severity: RuntimeDependencySeverity;
  installModeLabel: string;
  downloadLabel: string;
  purposeLabel: string;
  detailLabel: string;
  needsAttention: boolean;
}

export interface RuntimeDependencySection {
  id: string;
  title: string;
  items: RuntimeDependencyViewItem[];
}

export interface RuntimeDependencyViewModel {
  summary: {
    total: number;
    requiredMissing: number;
    optionalMissing: number;
    onDemandCount: number;
    readyCount: number;
  };
  requiredIssues: RuntimeDependencyViewItem[];
  sections: RuntimeDependencySection[];
}

const STATUS_LABELS: Record<string, string> = {
  available: '可用',
  configured: '已配置',
  missing: '缺失',
  unknown: '待检测',
  not_applicable: '不适用',
  degraded: '降级',
};

const INSTALL_MODE_LABELS: Record<string, string> = {
  bundled: '随包',
  system: '系统探测',
  'on-demand': '按需下载',
  environment: '环境配置',
};

function statusSeverity(status: string, required: boolean): RuntimeDependencySeverity {
  if (status === 'available' || status === 'configured') return 'ok';
  if (status === 'not_applicable') return 'muted';
  if (required && (status === 'missing' || status === 'degraded')) return 'error';
  return 'warn';
}

export function formatDependencyBytes(bytes: number, installMode = ''): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    if (installMode === 'bundled') return '随包';
    if (installMode === 'system') return '系统探测';
    if (installMode === 'environment') return '环境配置';
    return '无需下载';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `约 ${rounded}${units[unit]}`;
}

function toViewItem(item: RuntimeDependency): RuntimeDependencyViewItem {
  const severity = statusSeverity(item.status, item.required);
  return {
    ...item,
    statusLabel: STATUS_LABELS[item.status] || item.status,
    severity,
    installModeLabel: INSTALL_MODE_LABELS[item.installMode] || item.installMode,
    downloadLabel: formatDependencyBytes(item.estimatedDownloadBytes, item.installMode),
    purposeLabel: item.description || '暂无用途说明',
    detailLabel: item.detail || '暂无检测说明',
    needsAttention: severity === 'error' || severity === 'warn',
  };
}

export function toRuntimeDependencyViewModel(response: RuntimeDependencyResponse): RuntimeDependencyViewModel {
  const items = response.dependencies.map(toViewItem);
  const sectionMap = new Map<string, RuntimeDependencyViewItem[]>();
  for (const item of items) {
    const list = sectionMap.get(item.section) || [];
    list.push(item);
    sectionMap.set(item.section, list);
  }
  const sections = [...sectionMap.entries()].map(([id, sectionItems]) => ({
    id,
    title: `计划 ${id}`,
    items: sectionItems,
  }));
  return {
    summary: {
      total: response.summary.total || items.length,
      requiredMissing: response.summary.requiredMissing || items.filter((item) => item.required && item.needsAttention).length,
      optionalMissing: items.filter((item) => !item.required && item.needsAttention).length,
      onDemandCount: items.filter((item) => item.installMode === 'on-demand').length,
      readyCount: items.filter((item) => item.severity === 'ok').length,
    },
    requiredIssues: items.filter((item) => item.required && item.needsAttention),
    sections,
  };
}
