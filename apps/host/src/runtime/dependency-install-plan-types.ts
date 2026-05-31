import type { SupplyChainPrecheck } from './dependency-plan-utils.js';

export type RuntimeDependencyInstallPlanOptions = { selectedIds?: unknown[]; freeBytes?: unknown };
export type RuntimeDependencyCleanupPlanOptions = {
  selectedIds?: unknown[];
  appDataRoot?: string | null;
  keepUserData?: boolean;
};
export type RuntimeDependencyUpdatePlanOptions = {
  selectedIds?: unknown[];
  appDataRoot?: string | null;
  currentVersion?: unknown;
  targetVersion?: unknown;
};

export type InstallPlanComponent = Record<string, unknown> & {
  id: string;
  label: string;
  needsDownload: boolean;
  estimatedDownloadBytes: number;
  supplyChain: SupplyChainPrecheck;
};

export type PlanTarget = Record<string, unknown>;
export type RetainedPlanItem = Record<string, unknown> & { relativePath: string };
