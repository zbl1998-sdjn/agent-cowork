// Model provider profile management (host L1 kimi domain).
// Keeps each provider's credential and endpoint independent while exposing one active config.
import type { AgentModelConfig, ProviderProfile } from './api-runner-config.js';
import {
  apiKeyFromEnvForProvider,
  composeFullModelId,
  defaultBaseUrlForProvider,
  defaultModelForProvider,
  listModelProviderCatalog,
  normaliseModelProviderId,
  providerRequiresApiKey,
} from './provider/catalog.js';
import { decideModelProviderPolicy, type ModelProviderPolicy } from '../security/security-mode.js';

export type ProviderRuntimeState = {
  provider: string;
  configured: boolean;
  enabled: boolean;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  policyDecision: ModelProviderPolicy['decision'];
  providerClass: ModelProviderPolicy['providerClass'];
  reasonCode: string;
  reason: string;
};

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function cleanBaseUrl(value: unknown): string {
  return cleanText(value).replace(/\/+$/, '');
}

function profileConfigured(provider: string, profile: ProviderProfile): boolean {
  return providerRequiresApiKey(provider)
    ? Boolean(cleanText(profile.apiKey))
    : Boolean(cleanBaseUrl(profile.baseUrl) && cleanText(profile.model));
}

export function activeProviderProfile(config: AgentModelConfig): ProviderProfile {
  return {
    apiKey: cleanText(config.apiKey),
    baseUrl: cleanBaseUrl(config.baseUrl),
    model: cleanText(config.model),
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    ...(typeof config.temperature === 'number' ? { temperature: config.temperature } : {}),
  };
}

export function syncActiveProviderProfile(config: AgentModelConfig): void {
  const provider = normaliseModelProviderId(config.provider, 'kimi-api');
  config.providerProfiles ||= {};
  config.provider = provider;
  config.providerProfiles[provider] = activeProviderProfile(config);
  config.fullModelId = composeFullModelId(provider, config.model);
  config.configured = profileConfigured(provider, config.providerProfiles[provider] || {});
}

export function activateProviderProfile(
  config: AgentModelConfig,
  providerInput: unknown,
  env: Record<string, string | undefined> = process.env,
): void {
  syncActiveProviderProfile(config);
  const provider = normaliseModelProviderId(providerInput, 'kimi-api');
  const saved = (config.providerProfiles || {})[provider];
  config.provider = provider;
  config.apiKey = cleanText(saved?.apiKey || apiKeyFromEnvForProvider(provider, env));
  config.baseUrl = cleanBaseUrl(saved?.baseUrl || defaultBaseUrlForProvider(provider));
  config.model = cleanText(saved?.model || defaultModelForProvider(provider));
  config.timeoutMs = Math.max(1000, Number(saved?.timeoutMs || config.timeoutMs));
  config.maxTokens = Math.max(1, Number(saved?.maxTokens || config.maxTokens));
  if (typeof saved?.temperature === 'number') config.temperature = saved.temperature;
  else delete config.temperature;
  syncActiveProviderProfile(config);
}

export function providerRuntimeState(config: AgentModelConfig, providerInput: unknown): ProviderRuntimeState {
  const provider = normaliseModelProviderId(providerInput, 'kimi-api');
  const active = provider === normaliseModelProviderId(config.provider, 'kimi-api');
  const profile = active ? activeProviderProfile(config) : (config.providerProfiles || {})[provider] || {};
  const baseUrl = cleanBaseUrl(profile.baseUrl || defaultBaseUrlForProvider(provider));
  const model = cleanText(profile.model || defaultModelForProvider(provider));
  const apiKey = cleanText(profile.apiKey);
  const configured = profileConfigured(provider, { ...profile, apiKey, baseUrl, model });
  const policy = decideModelProviderPolicy(
    { provider, baseUrl, model, securityMode: config.securityMode },
    { securityMode: config.securityMode },
  );
  return {
    provider,
    configured,
    enabled: configured && policy.decision === 'allow',
    hasKey: Boolean(apiKey),
    baseUrl,
    model,
    policyDecision: policy.decision,
    providerClass: policy.providerClass,
    reasonCode: policy.reasonCode,
    reason: policy.reason,
  };
}

export function listProviderRuntimeStates(config: AgentModelConfig): ProviderRuntimeState[] {
  const ids = new Set(listModelProviderCatalog().map((entry) => entry.id));
  for (const id of Object.keys(config.providerProfiles || {})) ids.add(normaliseModelProviderId(id, id));
  return [...ids].map((provider) => providerRuntimeState(config, provider));
}

export function cloneProviderProfiles(
  profiles: Record<string, ProviderProfile> | undefined,
): Record<string, ProviderProfile> {
  return Object.fromEntries(
    Object.entries(profiles || {}).map(([provider, profile]) => [provider, { ...profile }]),
  );
}
