// @ts-check
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

/** @param {ModelConfig} [kimiConfig] @returns {Provider} */
export function resolveModelProvider(kimiConfig = {}) {
  const injected = kimiConfig.provider;
  const provider = /** @type {Partial<Provider>} */ (injected && typeof injected === 'object' ? injected : {});
  if (typeof provider.chatCompletion === 'function') {
    return /** @type {Provider} */ (injected);
  }
  const id = String(kimiConfig.provider || 'kimi').trim().toLowerCase() || 'kimi';
  return /** @type {Provider} */ (BUILTIN_PROVIDERS.get(id) || BUILTIN_PROVIDERS.get('kimi'));
}

/** @param {ProviderChatArgs} args */
export async function callProviderChatCompletion(args) {
  const provider = resolveModelProvider(args?.kimiConfig);
  return provider.chatCompletion(args);
}
