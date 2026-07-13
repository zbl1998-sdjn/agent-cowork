// Kimi 配置 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:读取/保存模型(provider/key/baseUrl/model)配置及其启用与连通状态。
// 依赖/对应路由:GET /api/kimi/info、POST /api/kimi/config。导出:getKimiInfo / saveKimiConfig + KimiInfo / SaveKimiConfigInput 类型。
import { getJson, postJson } from './transport';

export interface ModelProviderOption {
  id: string;
  displayName: string;
  aliases?: string[] | undefined;
  region: 'cn' | 'global' | 'local' | 'enterprise' | 'custom';
  protocol: 'openai-chat' | 'anthropic-messages';
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  apiKeyEnv: string[];
  requiresApiKey: boolean;
  allowCustomBaseUrl?: boolean | undefined;
  allowCustomModel?: boolean | undefined;
  baseUrlRequired?: boolean | undefined;
  source: 'builtin';
  runtimeState?: ModelProviderRuntimeState | undefined;
}

export interface ModelProviderRuntimeState {
  provider: string;
  configured: boolean;
  enabled: boolean;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  policyDecision: 'allow' | 'deny' | 'needs_approval';
  providerClass: 'local' | 'customer_gateway' | 'external_provider';
  reasonCode: string;
  reason: string;
}

export interface ModelConnectionResult {
  status: 'connected' | 'model_missing' | 'unreachable' | 'blocked';
  models: string[];
  modelAvailable?: boolean | undefined;
  latencyMs: number;
  error?: string | undefined;
}

export interface OpenCodeModelInfo {
  id: string;
  name: string;
  providerID: string;
  enabled: boolean;
}

export interface OpenCodeProviderInfo {
  id: string;
  name: string;
  source: 'env' | 'config' | 'custom';
  env: string[];
  options: { baseURL?: string | undefined; requiresApiKey: boolean };
  models: Record<string, OpenCodeModelInfo>;
}

export interface OpenCodeProviderCatalog {
  all: Record<string, OpenCodeProviderInfo>;
  connected: string[];
  default: Record<string, string>;
}

export interface ModelCatalogSource {
  id: 'models.dev' | 'builtin';
  url: string;
  fetchedAt: string;
  providerCount: number;
  modelCount: number;
  selectedProviderCount: number;
  selectedModelCount: number;
  error?: string | undefined;
  missingProviderIds?: string[] | undefined;
  excludedModels?: Record<string, string[]> | undefined;
}

export interface KimiInfo {
  provider?: string | undefined;
  configured: boolean;
  chatEnabled: boolean;
  planEnabled: boolean;
  model: string;
  fullModelId?: string | undefined;
  modelIdFormat?: 'provider_id/model_id' | string | undefined;
  baseUrl?: string | undefined;
  hasKey?: boolean | undefined;
  providers?: ModelProviderOption[] | undefined;
  catalog?: OpenCodeProviderCatalog | undefined;
  catalogSource?: ModelCatalogSource | undefined;
  providerStates?: ModelProviderRuntimeState[] | undefined;
  availableModels?: string[] | undefined;
  connection?: ModelConnectionResult | null | undefined;
}

export async function getKimiInfo(): Promise<KimiInfo> {
  return getJson('/api/kimi/info');
}

export interface SaveKimiConfigInput {
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  clearKey?: boolean | undefined;
}

export async function saveKimiConfig(input: SaveKimiConfigInput): Promise<KimiInfo> {
  return postJson<KimiInfo>('/api/kimi/config', { ...input });
}

export interface TestKimiConfigInput {
  action?: 'models' | undefined;
  provider?: string | undefined;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface TestKimiConfigResult {
  provider: string;
  model: string;
  models: string[];
  connection: ModelConnectionResult;
}

export async function testKimiConfig(input: TestKimiConfigInput): Promise<TestKimiConfigResult> {
  return postJson<TestKimiConfigResult>('/api/kimi/test', { action: 'models', ...input });
}
