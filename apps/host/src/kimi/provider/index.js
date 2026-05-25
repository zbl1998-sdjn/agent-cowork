import { createAnthropicProvider } from './anthropic.js';
import { createKimiProvider } from './kimi.js';
import { createLocalOpenAiCompatibleProvider, createOpenAiProvider } from './openai-compatible.js';

const anthropicProvider = createAnthropicProvider();
const kimiProvider = createKimiProvider();
const openAiProvider = createOpenAiProvider();
const localOpenAiProvider = createLocalOpenAiCompatibleProvider();

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

export function resolveModelProvider(kimiConfig = {}) {
  if (kimiConfig.provider && typeof kimiConfig.provider.chatCompletion === 'function') {
    return kimiConfig.provider;
  }
  const id = String(kimiConfig.provider || 'kimi').trim().toLowerCase() || 'kimi';
  return BUILTIN_PROVIDERS.get(id) || BUILTIN_PROVIDERS.get('kimi');
}

export async function callProviderChatCompletion(args) {
  const provider = resolveModelProvider(args?.kimiConfig);
  return provider.chatCompletion(args);
}
