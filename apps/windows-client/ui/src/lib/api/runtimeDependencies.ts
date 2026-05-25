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

export function getRuntimeDependencies(): Promise<RuntimeDependencyResponse> {
  return getJson<RuntimeDependencyResponse>('/api/runtime/dependencies');
}

export function getRuntimeDependencyInstallPlan(
  request: RuntimeDependencyInstallPlanRequest,
): Promise<RuntimeDependencyInstallPlanResponse> {
  return postJson<RuntimeDependencyInstallPlanResponse>('/api/runtime/dependencies/install-plan', request);
}
