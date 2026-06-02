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
import { createLocalOpenAiCompatibleProvider, createOpenAiProvider } from './openai-compatible.js';
import type { ModelConfig, Provider, ProviderChatArgs } from './types.js';

export type { ModelConfig, Provider, ProviderChatArgs } from './types.js';

const anthropicProvider = createAnthropicProvider();
const kimiProvider = createKimiProvider();
const openAiProvider = createOpenAiProvider();
const localOpenAiProvider = createLocalOpenAiCompatibleProvider();

const BUILTIN_PROVIDERS = new Map<string, Provider>([
  ['kimi', kimiProvider],
  ['kimi-api', kimiProvider],
  ['openai', openAiProvider],
  ['openai-compatible', openAiProvider],
  ['anthropic', anthropicProvider],
  ['claude', anthropicProvider],
  ['openai/local', localOpenAiProvider],
  ['local-openai', localOpenAiProvider],
  ['local', localOpenAiProvider],
]);

// 解析目标 Provider:优先使用注入实现,否则按别名表查找,未知 id 兜底到 kimi。
export function resolveModelProvider(kimiConfig: ModelConfig = {}): Provider {
  const injected = kimiConfig.provider;
  const provider = injected && typeof injected === 'object' ? injected as Partial<Provider> : {};
  if (typeof provider.chatCompletion === 'function') {
    return injected as Provider;
  }

  const id = String(kimiConfig.provider || 'kimi').trim().toLowerCase() || 'kimi';
  const fallback = BUILTIN_PROVIDERS.get('kimi');
  if (!fallback) {
    throw new Error('Built-in kimi provider is not registered');
  }
  return BUILTIN_PROVIDERS.get(id) || fallback;
}

// 统一发起一次对话补全,让调用方无需感知具体 provider 实现。
export async function callProviderChatCompletion(args: ProviderChatArgs): Promise<unknown> {
  const provider = resolveModelProvider(args?.kimiConfig);
  return provider.chatCompletion(args);
}
