// Model provider catalog(host · L1 domain · kimi/provider)
// ---------------------------------------------------------------------------
// OpenCode-inspired routing surface: users select provider_id/model_id.
// 类型见 catalog-types.ts,数据见 catalog-data.ts;本文件保留查询/解析函数,
// 并 re-export 类型与数据以保持对外 API 不变。
export * from './catalog-types.js';
import { MODEL_ID_FORMAT } from './catalog-types.js';
import type { ProviderCatalogEntry, ProviderCatalogResponse, OpenCodeProviderInfo, OpenCodeProviderCatalog } from './catalog-types.js';
import { MODEL_PROVIDER_CATALOG } from './catalog-data.js';

export { MODEL_PROVIDER_CATALOG };

function cleanId(value: unknown): string { return String(value || '').trim().toLowerCase(); }

function cloneEntry(entry: ProviderCatalogEntry): ProviderCatalogEntry {
  return { ...entry, aliases: [...entry.aliases], models: [...entry.models], apiKeyEnv: [...entry.apiKeyEnv] };
}

const LOOKUP = new Map<string, ProviderCatalogEntry>();
for (const entry of MODEL_PROVIDER_CATALOG) {
  LOOKUP.set(entry.id, entry);
  for (const alias of entry.aliases) LOOKUP.set(alias, entry);
}

const PREFIXES = [...LOOKUP.keys()].sort((a, b) => b.length - a.length);

export function listModelProviderCatalog(): ProviderCatalogEntry[] {
  return MODEL_PROVIDER_CATALOG.map(cloneEntry);
}

export function modelProviderCatalogResponse(): ProviderCatalogResponse {
  return { modelIdFormat: MODEL_ID_FORMAT, providers: listModelProviderCatalog(), catalog: openCodeProviderCatalog() };
}

export function openCodeProviderCatalog(env: Record<string, string | undefined> = process.env): OpenCodeProviderCatalog {
  const all: Record<string, OpenCodeProviderInfo> = {};
  const connected: string[] = [];
  const defaults: Record<string, string> = {};
  for (const entry of MODEL_PROVIDER_CATALOG) {
    const models = Object.fromEntries(entry.models.map((model) => [model, {
      id: model,
      name: model,
      providerID: entry.id,
      enabled: true,
    }]));
    const hasEnvKey = entry.apiKeyEnv.some((name) => Boolean(env[name]?.trim()));
    const isConnected = !entry.requiresApiKey || hasEnvKey;
    if (isConnected) connected.push(entry.id);
    if (entry.defaultModel) defaults[entry.id] = entry.defaultModel;
    const options: OpenCodeProviderInfo['options'] = { requiresApiKey: entry.requiresApiKey };
    if (entry.defaultBaseUrl) options.baseURL = entry.defaultBaseUrl;
    all[entry.id] = {
      id: entry.id,
      name: entry.displayName,
      source: entry.region === 'custom' ? 'custom' : hasEnvKey ? 'env' : 'config',
      env: [...entry.apiKeyEnv],
      options,
      models,
    };
  }
  return { all, connected, default: defaults };
}

export function findModelProviderCatalog(provider: unknown): ProviderCatalogEntry | undefined {
  return LOOKUP.get(cleanId(provider));
}

export function normaliseModelProviderId(provider: unknown, fallback = 'kimi-api'): string {
  const id = cleanId(provider);
  if (!id) return fallback;
  return findModelProviderCatalog(id)?.id || id;
}

export function providerRequiresApiKey(provider: unknown): boolean {
  return findModelProviderCatalog(provider)?.requiresApiKey ?? true;
}

export function defaultBaseUrlForProvider(provider: unknown): string {
  return findModelProviderCatalog(provider)?.defaultBaseUrl || '';
}

export function defaultModelForProvider(provider: unknown): string {
  return findModelProviderCatalog(provider)?.defaultModel || '';
}

export function apiKeyFromEnvForProvider(provider: unknown, env: Record<string, string | undefined>): string {
  const entry = findModelProviderCatalog(provider);
  for (const name of entry?.apiKeyEnv || []) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function splitFullModelId(value: unknown): { provider?: string; model: string; fullModelId: string } {
  const fullModelId = String(value || '').trim();
  if (!fullModelId) return { model: '', fullModelId: '' };
  for (const prefix of PREFIXES) {
    if (fullModelId.toLowerCase().startsWith(`${prefix}/`)) {
      return {
        provider: normaliseModelProviderId(prefix),
        model: fullModelId.slice(prefix.length + 1),
        fullModelId,
      };
    }
  }
  const slash = fullModelId.indexOf('/');
  if (slash <= 0) return { model: fullModelId, fullModelId };
  return {
    provider: normaliseModelProviderId(fullModelId.slice(0, slash), ''),
    model: fullModelId.slice(slash + 1),
    fullModelId,
  };
}

export function composeFullModelId(provider: unknown, model: unknown): string {
  const providerId = normaliseModelProviderId(provider, '');
  const modelId = String(model || '').trim();
  return providerId && modelId ? `${providerId}/${modelId}` : modelId;
}
