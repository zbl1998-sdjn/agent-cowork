import type { AgentEngineInfo, ModelProviderOption } from '../lib/api';

interface RuntimeDefaults {
  chatEnabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  models: string[];
  providers: ModelProviderOption[];
}

const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'openai/local']);

function isLocalProviderId(id: string): boolean {
  return id.includes('local') || LOCAL_PROVIDER_IDS.has(id);
}

function providersFromCatalog(info: Partial<AgentEngineInfo> | null | undefined): ModelProviderOption[] {
  const states = new Map((info?.providerStates || []).map((state) => [state.provider, state]));
  if (Array.isArray(info?.providers) && info.providers.length) {
    return info.providers.map((item) => ({
      ...item,
      ...(states.get(item.id) ? { runtimeState: states.get(item.id) } : {}),
    }));
  }
  const catalog = info?.catalog?.all || {};
  return Object.values(catalog).map((item) => ({
    id: item.id,
    displayName: item.name,
    region: isLocalProviderId(item.id) ? 'local' : item.source === 'custom' ? 'custom' : 'cn',
    protocol: 'openai-chat',
    defaultBaseUrl: item.options.baseURL || '',
    defaultModel: info?.catalog?.default?.[item.id] || Object.keys(item.models)[0] || '',
    models: Object.keys(item.models),
    apiKeyEnv: item.env,
    requiresApiKey: item.options.requiresApiKey,
    allowCustomModel: true,
    allowCustomBaseUrl: item.source === 'custom' || isLocalProviderId(item.id),
    source: 'builtin',
    ...(states.get(item.id) ? { runtimeState: states.get(item.id) } : {}),
  }));
}

export function runtimeDefaultsFromAgentEngineInfo(info: Partial<AgentEngineInfo> | null | undefined): RuntimeDefaults {
  const providers = providersFromCatalog(info);
  const provider = info?.provider || 'kimi-api';
  const model = info?.model || '';
  const selectedProvider = providers.find((item) => item.id === provider);
  const modelSet = new Set<string>();
  if (model) modelSet.add(model);
  for (const candidate of info?.availableModels || []) if (candidate) modelSet.add(candidate);
  if (selectedProvider?.defaultModel) modelSet.add(selectedProvider.defaultModel);
  for (const candidate of selectedProvider?.models || []) if (candidate) modelSet.add(candidate);
  return {
    chatEnabled: Boolean(info?.chatEnabled),
    provider,
    baseUrl: info?.baseUrl || '',
    model,
    models: [...modelSet],
    providers,
  };
}
