// 运行时依赖视图类型(UI · 类型层 · lib)
// ---------------------------------------------------------------------------
// 职责:依赖体检面板各视图模型的共享类型单一来源——整形后的依赖项、严重度、概览,
// 以及安装/清理/更新保留计划的视图模型。由 runtime-dependencies 整形逻辑产出、面板消费。
// 导出:RuntimeDependencySeverity、RuntimeDependencyViewItem/Section/ViewModel 及各计划视图模型。
import type { RuntimeDependency } from './api/runtimeDependencies';

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
  updatePlanCandidateIds: string[];
  updatePlanCandidateLabel: string;
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

export interface RuntimeDependencyUpdatePlanViewModel {
  ok: boolean;
  title: string;
  versionLabel: string;
  appDataRoot: string;
  componentLabels: string[];
  retainedLabels: string[];
  unknownIds: string[];
  destructiveActionCount: number;
  installerInvariant: string;
}
