// @ts-check

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

/**
 * @typedef {Record<string, unknown> & { provider?: unknown, chatCompletion?: Provider['chatCompletion'] }} ModelConfig
 * @typedef {{ messages?: unknown[], tools?: unknown[], kimiConfig?: ModelConfig, fetchImpl?: unknown, onContent?: (delta: string) => void, onReasoning?: (delta: string) => void, signal?: AbortSignal }} ProviderChatArgs
 * @typedef {{ id: string, chatCompletion(args: ProviderChatArgs): unknown | Promise<unknown> }} Provider
 */

const anthropicProvider = createAnthropicProvider();
const kimiProvider = createKimiProvider();
const openAiProvider = createOpenAiProvider();
const localOpenAiProvider = createLocalOpenAiCompatibleProvider();

/** @type {Map<string, Provider>} */
const BUILTIN_PROVIDERS = new Map([
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

/** 解析目标 Provider:优先用配置中注入的自定义实现,否则按 id 查注册表,兜底回 kimi。 @param {ModelConfig} [kimiConfig] @returns {Provider} */
export function resolveModelProvider(kimiConfig = {}) {
  const injected = kimiConfig.provider;
  const provider = /** @type {Partial<Provider>} */ (injected && typeof injected === 'object' ? injected : {});
  if (typeof provider.chatCompletion === 'function') {
    return /** @type {Provider} */ (injected);
  }
  const id = String(kimiConfig.provider || 'kimi').trim().toLowerCase() || 'kimi';
  return /** @type {Provider} */ (BUILTIN_PROVIDERS.get(id) || BUILTIN_PROVIDERS.get('kimi'));
}

/** 解析出 Provider 后统一发起一次对话补全(注册表对调用方屏蔽具体实现)。 @param {ProviderChatArgs} args */
export async function callProviderChatCompletion(args) {
  const provider = resolveModelProvider(args?.kimiConfig);
  return provider.chatCompletion(args);
}
