import { getJson } from './transport';

export type RuntimeDependencyStatus = 'available' | 'configured' | 'missing' | 'unknown' | 'not_applicable' | 'degraded' | string;

export interface RuntimeDependency {
  id: string;
  section: string;
  label: string;
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

export function getRuntimeDependencies(): Promise<RuntimeDependencyResponse> {
  return getJson<RuntimeDependencyResponse>('/api/runtime/dependencies');
}
