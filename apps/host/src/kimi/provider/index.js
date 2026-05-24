import { createKimiProvider } from './kimi.js';

const BUILTIN_PROVIDERS = new Map([
  ['kimi', createKimiProvider()],
  ['kimi-api', createKimiProvider()],
]);

export function resolveModelProvider(kimiConfig = {}) {
  if (kimiConfig.provider && typeof kimiConfig.provider.chatCompletion === 'function') {
    return kimiConfig.provider;
  }
  const id = String(kimiConfig.provider || 'kimi').trim() || 'kimi';
  return BUILTIN_PROVIDERS.get(id) || BUILTIN_PROVIDERS.get('kimi');
}

export async function callProviderChatCompletion(args) {
  const provider = resolveModelProvider(args?.kimiConfig);
  return provider.chatCompletion(args);
}
