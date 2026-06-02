// 运行时依赖安装/清理/更新计划的类型契约(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:集中定义依赖计划的入参选项与计划项结构(安装组件、保留项、清理/更新目标),
//       让计划生成逻辑(dependency-plan-utils 等)只负责编排,类型不散落。
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
