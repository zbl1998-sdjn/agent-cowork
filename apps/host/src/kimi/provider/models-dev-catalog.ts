// Models.dev catalog adapter(host · L1 domain · kimi/provider)
// ---------------------------------------------------------------------------
// OpenCode uses https://models.dev/api.json as the provider/model directory.
// This adapter keeps our UI catalog refreshed without putting API keys or
// provider secrets in responses.
import {
  modelProviderCatalogResponse,
  listModelProviderCatalog,
  type OpenCodeProviderCatalog,
  type OpenCodeProviderInfo,
  type ProviderCatalogEntry,
  type ProviderCatalogResponse,
} from './catalog.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2500;

type JsonResponseLike = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};
type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<JsonResponseLike>;
type RawObject = Record<string, unknown>;

export type ModelsDevCatalogSource = {
  id: 'models.dev' | 'builtin';
  url: string;
  fetchedAt: string;
  providerCount: number;
  modelCount: number;
  selectedProviderCount: number;
  selectedModelCount: number;
  error?: string;
  missingProviderIds?: string[];
  excludedModels?: Record<string, string[]>;
};

export type ModelsDevCatalogResponse = ProviderCatalogResponse & {
  source: ModelsDevCatalogSource;
};

type CacheEntry = {
  expiresAt: number;
  value: ModelsDevCatalogResponse;
};

const MODELS_DEV_PROVIDER_IDS: Record<string, string> = {
  'kimi-api': 'moonshotai',
  deepseek: 'deepseek',
  'qwen-dashscope-cn': 'alibaba-cn',
  'zai-glm': 'zhipuai',
  minimax: 'minimax',
  'siliconflow-cn': 'siliconflow-cn',
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  openrouter: 'openrouter',
  perplexity: 'perplexity',
};

const DEFAULT_MODEL_HINTS: Record<string, string[]> = {
  'kimi-api': ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  'qwen-dashscope-cn': ['qwen3.7-plus', 'qwen-plus', 'qwen-max'],
  'zai-glm': ['glm-5.2', 'glm-5.1', 'glm-5'],
  minimax: ['MiniMax-M2.7', 'MiniMax-M3'],
  'siliconflow-cn': ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'Pro/deepseek-ai/DeepSeek-V3.2'],
  openai: ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5-codex', 'gpt-image-2'],
  anthropic: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
  google: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro'],
  xai: ['grok-4.3', 'grok-build-0.1'],
  groq: ['llama-3.3-70b-versatile'],
  mistral: ['mistral-large-latest', 'mistral-medium-latest'],
  openrouter: ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-4.8', 'openai/gpt-5.5'],
  perplexity: ['sonar-pro', 'sonar'],
};

const MODEL_EXCLUDES: Record<string, string[]> = {
  'kimi-api': ['kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'kimi-k2-0711-preview', 'kimi-k2-turbo-preview'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-r1'],
  google: ['gemini-3-pro-preview'],
  xai: ['grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-4.20-multi-agent-0309'],
  openai: ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-5.2-chat-latest', 'gpt-5-pro', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini'],
};

let cache: CacheEntry | null = null;

function asObject(value: unknown): RawObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RawObject : {};
}

function providerModels(provider: RawObject): string[] {
  return Object.keys(asObject(provider.models)).filter(Boolean);
}

function pickDefaultModel(providerId: string, models: readonly string[], fallback: string): string {
  for (const hint of DEFAULT_MODEL_HINTS[providerId] || []) {
    if (models.includes(hint)) return hint;
  }
  if (fallback && models.includes(fallback)) return fallback;
  return models[0] || fallback;
}

function withModelsDevModels(entry: ProviderCatalogEntry, provider: RawObject): ProviderCatalogEntry {
  const excluded = new Set(MODEL_EXCLUDES[entry.id] || []);
  const models = providerModels(provider).filter((model) => !excluded.has(model));
  if (!models.length) return entry;
  return {
    ...entry,
    models,
    defaultModel: pickDefaultModel(entry.id, models, entry.defaultModel),
  };
}

function openCodeProviderCatalogFromEntries(
  entries: readonly ProviderCatalogEntry[],
  env: Record<string, string | undefined>,
): OpenCodeProviderCatalog {
  const all: Record<string, OpenCodeProviderInfo> = {};
  const connected: string[] = [];
  const defaults: Record<string, string> = {};
  for (const entry of entries) {
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

function countRawModels(raw: RawObject): number {
  let count = 0;
  for (const provider of Object.values(raw)) count += providerModels(asObject(provider)).length;
  return count;
}

function fallbackResponse(error: string, env: Record<string, string | undefined>, now: number): ModelsDevCatalogResponse {
  const response = modelProviderCatalogResponse();
  const selectedModelCount = response.providers.reduce((sum, entry) => sum + entry.models.length, 0);
  return {
    ...response,
    catalog: openCodeProviderCatalogFromEntries(response.providers, env),
    source: {
      id: 'builtin',
      url: MODELS_DEV_API_URL,
      fetchedAt: new Date(now).toISOString(),
      providerCount: response.providers.length,
      modelCount: selectedModelCount,
      selectedProviderCount: response.providers.length,
      selectedModelCount,
      error,
    },
  };
}

function buildModelsDevCatalog(raw: RawObject, env: Record<string, string | undefined>, now: number): ModelsDevCatalogResponse {
  const missingProviderIds: string[] = [];
  const providers = listModelProviderCatalog().map((entry) => {
    const sourceId = MODELS_DEV_PROVIDER_IDS[entry.id];
    if (!sourceId) return entry;
    const provider = asObject(raw[sourceId]);
    if (!Object.keys(provider).length) {
      missingProviderIds.push(sourceId);
      return entry;
    }
    return withModelsDevModels(entry, provider);
  });
  const selectedModelCount = providers.reduce((sum, entry) => sum + entry.models.length, 0);
  const source: ModelsDevCatalogSource = {
    id: 'models.dev',
    url: MODELS_DEV_API_URL,
    fetchedAt: new Date(now).toISOString(),
    providerCount: Object.keys(raw).length,
    modelCount: countRawModels(raw),
    selectedProviderCount: providers.length,
    selectedModelCount,
    excludedModels: MODEL_EXCLUDES,
  };
  if (missingProviderIds.length) source.missingProviderIds = missingProviderIds;
  return {
    modelIdFormat: 'provider_id/model_id',
    providers,
    catalog: openCodeProviderCatalogFromEntries(providers, env),
    source,
  };
}

async function fetchModelsDev(fetchImpl: FetchLike, timeoutMs: number): Promise<RawObject> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(MODELS_DEV_API_URL, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'agent-cowork-model-catalog',
      },
    });
    if (!response.ok) throw new Error(`models.dev catalog failed with status ${response.status}`);
    return asObject(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export function clearModelsDevCatalogCache(): void {
  cache = null;
}

export async function modelsDevProviderCatalogResponse({
  env = process.env,
  fetchImpl = globalThis.fetch as unknown as FetchLike,
  now = Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  force = false,
}: {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  now?: number;
  timeoutMs?: number;
  force?: boolean;
} = {}): Promise<ModelsDevCatalogResponse> {
  if (!force && cache && cache.expiresAt > now) return cache.value;
  try {
    const raw = await fetchModelsDev(fetchImpl, timeoutMs);
    const value = buildModelsDevCatalog(raw, env, now);
    cache = { expiresAt: now + CACHE_TTL_MS, value };
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err || 'unknown error');
    return fallbackResponse(message, env, now);
  }
}
