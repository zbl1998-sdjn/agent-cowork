// 能力包 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:查询 host 暴露的 Capability/Role Pack 目录、推荐和安装计划预检。这里只生成计划,不执行下载或安装。
import { getJson, postJson, type PostBody } from './transport';
import type { RuntimeDependencyInstallPlanResponse } from './runtimeDependencies';

export const BEGINNER_OFFICE_TASK_INTENT = '小白办公 周报 日报 Excel Word PPT PDF OCR 会议纪要 邮件 回复 跟进';

export interface CapabilityPackPermission {
  kind: string;
  scope: string;
  reason: string;
  default: 'deny' | 'ask' | 'allow';
}

export interface CapabilityPack {
  schemaVersion: string;
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  publisher: string;
  license: string;
  capabilities: string[];
  dependencyIds: string[];
  requiredPackIds: string[];
  recommendedForRoles: string[];
  permissions: CapabilityPackPermission[];
  installMode: string;
  security: {
    signed: boolean;
    sandboxRequired: boolean;
    networkDuringRuntime: 'none' | 'ask' | 'required' | string;
  };
}

export interface CapabilityRecommendation extends CapabilityPack {
  reason: string;
  missingDependencyIds: string[];
}

export interface CapabilityCatalogResponse {
  ok: boolean;
  packs: CapabilityPack[];
  context?: unknown;
}

export interface CapabilityRecommendationResponse {
  ok: boolean;
  recommendations: CapabilityRecommendation[];
  context?: unknown;
}

export interface CapabilityInstallPlanRuntimePlan extends RuntimeDependencyInstallPlanResponse {
  supplyChain?: {
    status: string;
    message: string;
    issues?: Array<{ id: string; label: string; reasons: string[] }>;
  };
}

export interface CapabilityInstallPlanRequest extends PostBody {
  packIds?: string[];
  selectedIds?: string[];
  freeBytes?: number;
}

export interface CapabilityInstallPlanResponse {
  ok: boolean;
  packIds: string[];
  unknownPackIds: string[];
  dependencyIds: string[];
  runtimePlan: CapabilityInstallPlanRuntimePlan;
}

export function getCapabilityCatalog(): Promise<CapabilityCatalogResponse> {
  return getJson<CapabilityCatalogResponse>('/api/capabilities/catalog');
}

export function getCapabilityRecommendations(
  options: { role?: string; taskIntent?: string } = {},
): Promise<CapabilityRecommendationResponse> {
  const query = new URLSearchParams();
  if (options.role) query.set('role', options.role);
  if (options.taskIntent) query.set('taskIntent', options.taskIntent);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return getJson<CapabilityRecommendationResponse>(`/api/capabilities/recommend${suffix}`);
}

export function getCapabilityInstallPlan(request: CapabilityInstallPlanRequest): Promise<CapabilityInstallPlanResponse> {
  return postJson<CapabilityInstallPlanResponse>('/api/capabilities/install-plan', request);
}
