import { getJson, postJson, type PostBody } from './transport';

export type RuntimeDependencyStatus = 'available' | 'configured' | 'missing' | 'unknown' | 'not_applicable' | 'degraded' | string;

export interface RuntimeDependency {
  id: string;
  section: string;
  label: string;
  description?: string;
  required: boolean;
  installMode: string;
  estimatedDownloadBytes: number;
  status: RuntimeDependencyStatus;
  detail?: string;
  source?: string;
  version?: string;
  // Catalog may provide a vendor download page so the UI can offer a one-click
  // "open in browser" install path for the user instead of just stating "missing".
  sourceUrl?: string | null;
}

export interface RuntimeDependencySummary {
  total: number;
  requiredMissing: number;
  byStatus: Record<string, number>;
}

export interface RuntimeDependencyResponse {
  ok: boolean;
  service: string;
  generatedAt: string;
  platform: string;
  arch: string;
  dependencies: RuntimeDependency[];
  summary: RuntimeDependencySummary;
}

export interface RuntimeDependencyInstallPlanRequest extends PostBody {
  selectedIds: string[];
  freeBytes?: number;
}

export interface RuntimeDependencyInstallPlanComponent {
  id: string;
  section: string;
  label: string;
  installMode: string;
  required: boolean;
  estimatedDownloadBytes: number;
  needsDownload: boolean;
}

export interface RuntimeDependencyInstallPlanDisk {
  status: 'unknown' | 'insufficient' | 'ok' | string;
  availableBytes: number | null;
  requiredBytes: number;
  missingBytes: number;
  message: string;
}

export interface RuntimeDependencyInstallPlanResponse {
  ok: boolean;
  components: RuntimeDependencyInstallPlanComponent[];
  unknownIds: string[];
  disk: RuntimeDependencyInstallPlanDisk;
}

export interface RuntimeDependencyCleanupPlanRequest extends PostBody {
  selectedIds?: string[];
  keepUserData?: boolean;
}

export interface RuntimeDependencyCleanupPlanTarget {
  id: string;
  label: string;
  relativePath?: string;
  path: string;
  action: 'remove' | string;
  kind: string;
  requiresConfirmation?: boolean;
}

export interface RuntimeDependencyCleanupPlanRetained {
  id: string;
  label: string;
  path: string;
  reason?: string;
}

export interface RuntimeDependencyCleanupPlanResponse {
  ok: boolean;
  mode: 'preserve-user-data' | 'remove-user-data' | string;
  appDataRoot: string;
  keepUserData: boolean;
  unknownIds: string[];
  targets: RuntimeDependencyCleanupPlanTarget[];
  retained: RuntimeDependencyCleanupPlanRetained[];
  warnings: string[];
}

export interface RuntimeDependencyUpdatePlanRequest extends PostBody {
  selectedIds?: string[];
  currentVersion?: string;
  targetVersion?: string;
}

export interface RuntimeDependencyUpdatePlanEntry {
  id: string;
  label: string;
  relativePath?: string;
  path: string;
  action: 'preserve' | string;
  kind: string;
  reason?: string;
}

export interface RuntimeDependencyUpdatePlanResponse {
  ok: boolean;
  mode: 'preserve-on-update' | string;
  currentVersion: string | null;
  targetVersion: string | null;
  appDataRoot: string;
  unknownIds: string[];
  components: RuntimeDependencyUpdatePlanEntry[];
  retained: RuntimeDependencyUpdatePlanEntry[];
  destructiveActions: unknown[];
  installerInvariant: string;
}

export function getRuntimeDependencies(): Promise<RuntimeDependencyResponse> {
  return getJson<RuntimeDependencyResponse>('/api/runtime/dependencies');
}

export function getRuntimeDependencyInstallPlan(
  request: RuntimeDependencyInstallPlanRequest,
): Promise<RuntimeDependencyInstallPlanResponse> {
  return postJson<RuntimeDependencyInstallPlanResponse>('/api/runtime/dependencies/install-plan', request);
}

export function getRuntimeDependencyCleanupPlan(
  request: RuntimeDependencyCleanupPlanRequest,
): Promise<RuntimeDependencyCleanupPlanResponse> {
  return postJson<RuntimeDependencyCleanupPlanResponse>('/api/runtime/dependencies/cleanup-plan', request);
}

export function getRuntimeDependencyUpdatePlan(
  request: RuntimeDependencyUpdatePlanRequest,
): Promise<RuntimeDependencyUpdatePlanResponse> {
  return postJson<RuntimeDependencyUpdatePlanResponse>('/api/runtime/dependencies/update-plan', request);
}
