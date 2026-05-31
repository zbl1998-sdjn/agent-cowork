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
