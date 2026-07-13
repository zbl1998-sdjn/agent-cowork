// 提供商注册表与解析入口(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:维护「provider id → Provider 实例」的内置注册表(BUILTIN_PROVIDERS),
//       按配置解析出目标 Provider(支持注入自定义实现),并统一发起 chatCompletion。
// 角色:这是多提供商可扩展设计的「注册表」中枢——新增一家提供商只需实现
//       { id, chatCompletion } 接口并在此登记别名,调用方无需改动。
// 依赖:同层各 provider 适配器(anthropic/kimi/openai-compatible)。
// 导出:resolveModelProvider(按配置解析)、callProviderChatCompletion(统一调用)。
import { createAnthropicProvider } from './anthropic.js';
import { createKimiProvider } from './kimi.js';
import { createLocalOpenAiCompatibleProvider, createOpenAiCompatibleProvider, createOpenAiProvider } from './openai-compatible.js';
import { MODEL_PROVIDER_CATALOG } from './catalog.js';
import { createModelEndpointFetch } from '../../security/model-endpoint-request.js';
import type { ModelConfig, Provider, ProviderChatArgs, ProviderChatResult } from './types.js';

export type { ModelConfig, Provider, ProviderChatArgs, ProviderChatResult } from './types.js';
export {
  composeFullModelId,
  defaultBaseUrlForProvider,
  defaultModelForProvider,
  findModelProviderCatalog,
  listModelProviderCatalog,
  modelProviderCatalogResponse,
  normaliseModelProviderId,
  openCodeProviderCatalog,
  providerRequiresApiKey,
  splitFullModelId,
} from './catalog.js';
export { clearModelsDevCatalogCache, modelsDevProviderCatalogResponse } from './models-dev-catalog.js';

const anthropicProvider = createAnthropicProvider();
const kimiProvider = createKimiProvider();
const openAiProvider = createOpenAiProvider();
const localOpenAiProvider = createLocalOpenAiCompatibleProvider();

function providerFromCatalogEntry(entry: (typeof MODEL_PROVIDER_CATALOG)[number]): Provider {
  if (entry.id === 'kimi-api') return kimiProvider;
  if (entry.id === 'openai') return openAiProvider;
  if (entry.id === 'anthropic') return anthropicProvider;
  if (entry.id === 'openai/local') return localOpenAiProvider;
  if (entry.protocol === 'openai-chat') {
    return createOpenAiCompatibleProvider({
      id: entry.id,
      defaultBaseUrl: entry.defaultBaseUrl,
      requiresApiKey: entry.requiresApiKey,
      includeStreamUsage: entry.region === 'local',
      notConfiguredMessage: `未配置 ${entry.displayName} 模型。请配置 baseUrl、model${entry.requiresApiKey ? ' 和 API key' : ''} 后重试。`,
    });
  }
  return kimiProvider;
}

function createBuiltinProviders(): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const entry of MODEL_PROVIDER_CATALOG) {
    const provider = providerFromCatalogEntry(entry);
    providers.set(entry.id, provider);
    for (const alias of entry.aliases) providers.set(alias, provider);
  }
  return providers;
}

const BUILTIN_PROVIDERS = createBuiltinProviders();

// 解析目标 Provider:优先使用注入实现,否则按别名表查找;未知 id 显式失败。
export function resolveModelProvider(kimiConfig: ModelConfig = {}): Provider {
  const injected = kimiConfig.provider;
  const provider = injected && typeof injected === 'object' ? injected as Partial<Provider> : {};
  if (typeof provider.chatCompletion === 'function') {
    return injected as Provider;
  }

  const id = String(kimiConfig.provider || 'kimi').trim().toLowerCase() || 'kimi';
  const resolved = BUILTIN_PROVIDERS.get(id);
  if (!resolved) throw new Error(`Unknown model provider: ${id}`);
  return resolved;
}

// 统一发起一次对话补全,让调用方无需感知具体 provider 实现。
export async function callProviderChatCompletion(args: ProviderChatArgs): Promise<ProviderChatResult> {
  const provider = resolveModelProvider(args?.kimiConfig);
  const kimiConfig = args?.kimiConfig || {};
  const fetchOptions = typeof args?.fetchImpl === 'function'
    ? { fetchImpl: args.fetchImpl as never }
    : {};
  // Every built-in provider shares one network boundary: real requests use a
  // DNS-validated, address-pinned socket and never follow redirects. A custom
  // fetchImpl is an explicit in-process dependency-injection capability.
  const fetchImpl = createModelEndpointFetch(kimiConfig, fetchOptions);
  return provider.chatCompletion({ ...args, fetchImpl });
}
