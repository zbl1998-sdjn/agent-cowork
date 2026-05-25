import type {
  RuntimeDependency,
  RuntimeDependencyCleanupPlanResponse,
  RuntimeDependencyInstallPlanResponse,
  RuntimeDependencyResponse,
} from './api/runtimeDependencies';

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
  installPlanCandidateIds: string[];
  installPlanCandidateLabel: string;
  cleanupPlanCandidateIds: string[];
  cleanupPlanCandidateLabel: string;
}

export interface RuntimeDependencyInstallPlanViewModel {
  ok: boolean;
  title: string;
  diskMessage: string;
  diskSeverity: RuntimeDependencySeverity;
  componentCount: number;
  requiredBytesLabel: string;
  missingBytesLabel: string;
  componentLabels: string[];
  unknownIds: string[];
}

export interface RuntimeDependencyCleanupPlanViewModel {
  ok: boolean;
  title: string;
  modeLabel: string;
  appDataRoot: string;
  targetCount: number;
  targetLabels: string[];
  retainedLabels: string[];
  warnings: string[];
  unknownIds: string[];
  requiresConfirmation: boolean;
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

function shouldPlanInstall(item: RuntimeDependencyViewItem): boolean {
  return item.installMode === 'on-demand' && item.needsAttention;
}

function shouldPlanCleanup(item: RuntimeDependencyViewItem): boolean {
  return item.installMode === 'on-demand';
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
  const installPlanCandidates = items.filter(shouldPlanInstall);
  const cleanupPlanCandidates = items.filter(shouldPlanCleanup);
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
    installPlanCandidateIds: installPlanCandidates.map((item) => item.id),
    installPlanCandidateLabel: installPlanCandidates.length
      ? installPlanCandidates.map((item) => item.label).join('、')
      : '暂无需要预检的按需组件',
    cleanupPlanCandidateIds: cleanupPlanCandidates.map((item) => item.id),
    cleanupPlanCandidateLabel: cleanupPlanCandidates.length
      ? cleanupPlanCandidates.map((item) => item.label).join('、')
      : '暂无可清理的按需组件',
  };
}

function diskSeverity(status: string): RuntimeDependencySeverity {
  if (status === 'ok') return 'ok';
  if (status === 'insufficient') return 'error';
  return 'warn';
}

export function toRuntimeDependencyInstallPlanViewModel(
  plan: RuntimeDependencyInstallPlanResponse,
): RuntimeDependencyInstallPlanViewModel {
  const requiredBytes = plan.disk.requiredBytes || 0;
  const missingBytes = plan.disk.missingBytes || 0;
  return {
    ok: plan.ok,
    title: plan.ok ? '安装计划预检通过' : '安装计划需要处理',
    diskMessage: plan.disk.message,
    diskSeverity: diskSeverity(plan.disk.status),
    componentCount: plan.components.length,
    requiredBytesLabel: formatDependencyBytes(requiredBytes, 'on-demand'),
    missingBytesLabel: missingBytes > 0 ? formatDependencyBytes(missingBytes, 'on-demand') : '0 B',
    componentLabels: plan.components.map((item) => item.label),
    unknownIds: plan.unknownIds,
  };
}

function cleanupModeLabel(mode: string, keepUserData: boolean): string {
  if (mode === 'preserve-user-data' || keepUserData) return '保留用户数据';
  if (mode === 'remove-user-data') return '删除用户数据';
  return mode || '未知清理模式';
}

export function toRuntimeDependencyCleanupPlanViewModel(
  plan: RuntimeDependencyCleanupPlanResponse,
): RuntimeDependencyCleanupPlanViewModel {
  const requiresConfirmation = plan.targets.some((item) => item.requiresConfirmation);
  return {
    ok: plan.ok,
    title: requiresConfirmation ? '清理计划需要二次确认' : plan.ok ? '清理计划预检通过' : '清理计划需要处理',
    modeLabel: cleanupModeLabel(plan.mode, plan.keepUserData),
    appDataRoot: plan.appDataRoot,
    targetCount: plan.targets.length,
    targetLabels: plan.targets.map((item) => `${item.label} · ${item.path}`),
    retainedLabels: plan.retained.map((item) => `${item.label} · ${item.reason || item.path}`),
    warnings: plan.warnings,
    unknownIds: plan.unknownIds,
    requiresConfirmation,
  };
}
