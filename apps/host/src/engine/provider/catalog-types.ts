// Model provider catalog types(host · L1 domain · kimi/provider)
// ---------------------------------------------------------------------------
// 共享类型:被 catalog.ts(函数)与 catalog-data.ts(数据)共同引用。
// 作为无依赖的叶子模块,打破 catalog ↔ catalog-data 的 import 循环。

export const MODEL_ID_FORMAT = 'provider_id/model_id' as const;

export type ProviderRegion = 'cn' | 'global' | 'local' | 'enterprise' | 'custom';
export type ProviderProtocol = 'openai-chat' | 'anthropic-messages';

export type ProviderCatalogEntry = Readonly<{
  id: string;
  displayName: string;
  aliases: readonly string[];
  region: ProviderRegion;
  protocol: ProviderProtocol;
  defaultBaseUrl: string;
  defaultModel: string;
  models: readonly string[];
  apiKeyEnv: readonly string[];
  requiresApiKey: boolean;
  allowCustomBaseUrl?: boolean;
  allowCustomModel?: boolean;
  baseUrlRequired?: boolean;
  source: 'builtin';
}>;

export type OpenCodeModelInfo = Readonly<{
  id: string;
  name: string;
  providerID: string;
  enabled: boolean;
}>;

export type OpenCodeProviderInfo = Readonly<{
  id: string;
  name: string;
  source: 'env' | 'config' | 'custom';
  env: readonly string[];
  options: { baseURL?: string; requiresApiKey: boolean };
  models: Record<string, OpenCodeModelInfo>;
}>;

export type OpenCodeProviderCatalog = Readonly<{
  all: Record<string, OpenCodeProviderInfo>;
  connected: string[];
  default: Record<string, string>;
}>;

export type ProviderCatalogResponse = Readonly<{
  modelIdFormat: typeof MODEL_ID_FORMAT;
  providers: ProviderCatalogEntry[];
  catalog: OpenCodeProviderCatalog;
}>;
