// Non-persisting model connection test (host L1 engine domain).
import type { AgentModelConfig } from './api-runner-config.js';
import { discoverProviderModels, type ModelDiscoveryResult } from './model-discovery.js';
import {
  activateProviderProfile,
  cloneProviderProfiles,
  syncActiveProviderProfile,
} from './provider-profiles.js';

export type ModelConnectionTestInput = {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export async function testModelConnection(
  saved: AgentModelConfig,
  input: ModelConnectionTestInput,
  fetchImpl?: typeof fetch,
): Promise<{
  provider: string;
  model: string;
  models: string[];
  connection: ModelDiscoveryResult;
}> {
  const candidate: AgentModelConfig = {
    ...saved,
    fallbacks: saved.fallbacks.map((item) => ({ ...item })),
    providerProfiles: cloneProviderProfiles(saved.providerProfiles),
  };
  if (input.provider && input.provider !== candidate.provider) {
    activateProviderProfile(candidate, input.provider);
  }
  if (input.apiKey?.trim()) candidate.apiKey = input.apiKey.trim();
  if (input.baseUrl?.trim()) candidate.baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
  if (input.model?.trim()) candidate.model = input.model.trim();
  syncActiveProviderProfile(candidate);
  const connection = await discoverProviderModels({
    provider: candidate.provider,
    apiKey: candidate.apiKey,
    baseUrl: candidate.baseUrl,
    model: candidate.model,
    securityMode: candidate.securityMode,
    timeoutMs: Math.min(candidate.timeoutMs, 5000),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    provider: candidate.provider,
    model: candidate.model,
    models: connection.models,
    connection,
  };
}
