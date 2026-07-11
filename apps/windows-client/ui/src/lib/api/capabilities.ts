// 受控能力包 API(UI · lib/api 传输层)
// ---------------------------------------------------------------------------
// 职责:读取 Host 的只读 capability pack 治理目录。没有下载、安装、启用或执行 API。
import { getJson } from './transport';

export type CapabilityPackGovernanceStatus = 'bundled_trusted' | 'review_required' | 'blocked';

export interface CapabilityPack {
  schemaVersion: 'agent-cowork.pack.v1';
  id: string;
  name: string;
  version: string;
  description: string;
  category: 'capability' | 'role' | 'connector' | 'model' | 'design';
  publisher: string;
  license: string;
  capabilities: string[];
  dependencyIds: string[];
  requiredPackIds: string[];
  recommendedForRoles: string[];
  permissions: Array<{
    kind: string;
    scope: string;
    reason: string;
    default: 'deny' | 'ask' | 'allow';
  }>;
  installMode: 'bundled' | 'plan-only';
  security: {
    signed: boolean;
    sandboxRequired: boolean;
    networkDuringRuntime: 'none' | 'ask' | 'required';
  };
  governance: {
    status: CapabilityPackGovernanceStatus;
    executable: boolean;
    reviewRequired: boolean;
    reasons: string[];
  };
}

interface CapabilityPackCatalogResponse {
  ok: boolean;
  packs: CapabilityPack[];
}

export async function getCapabilityPacks(): Promise<CapabilityPack[]> {
  const response = await getJson<CapabilityPackCatalogResponse>('/api/capabilities/catalog');
  if (!response.ok || !Array.isArray(response.packs)) {
    throw new Error('能力包治理目录响应无效');
  }
  return response.packs;
}
