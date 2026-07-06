// Security mode and model-provider classification (host L0 security).
// Keep this module pure so L1/L2 callers can share the same fail-closed rules.

export const SECURITY_MODES = Object.freeze([
  'local_demo',
  'local_strict',
  'enterprise_local',
  'air_gap',
  'controlled_hybrid',
] as const);

export type SecurityMode = typeof SECURITY_MODES[number];
export type LegacySecurityMode = 'enterprise_hybrid' | 'saas_opt_in';
export type RuntimeEnv = Record<string, string | undefined>;
export type ProviderClass = 'local' | 'customer_gateway' | 'external_provider';
export type ProviderPolicyDecision = 'allow' | 'deny' | 'needs_approval';

export type ModelProviderPolicy = {
  allowed: boolean;
  decision: ProviderPolicyDecision;
  securityMode: SecurityMode;
  providerClass: ProviderClass;
  reasonCode: string;
  reason: string;
  audit: {
    securityMode: SecurityMode;
    providerClass: ProviderClass;
    decision: ProviderPolicyDecision;
    reasonCode: string;
    provider: string;
    model: string;
    hasBaseUrl: boolean;
    baseHost?: string;
  };
};

export type CandidatePolicy<T extends Record<string, unknown>> = {
  config: T;
  policy: ModelProviderPolicy;
};

export type ModelCandidateFilter<T extends Record<string, unknown>> = {
  candidates: T[];
  decisions: Array<CandidatePolicy<T>>;
  denied: Array<CandidatePolicy<T>>;
};

const LOCAL_PROVIDER_IDS = new Set([
  'local',
  'local-openai',
  'openai/local',
  'ollama',
  'lmstudio',
  'lm-studio',
  'local-lmstudio',
  'local-vllm',
  'vllm/local',
]);

const SECURITY_MODE_ALIASES: Record<LegacySecurityMode, SecurityMode> = {
  enterprise_hybrid: 'enterprise_local',
  saas_opt_in: 'controlled_hybrid',
};

function clean(value: unknown): string {
  return String(value || '').trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function isSecurityMode(value: unknown): value is SecurityMode {
  return (SECURITY_MODES as readonly string[]).includes(lower(value));
}

export function normalizeSecurityMode(value: unknown, fallback: SecurityMode = 'controlled_hybrid'): SecurityMode {
  const mode = lower(value).replace(/[-\s]+/g, '_');
  if (mode === 'enterprise_hybrid' || mode === 'saas_opt_in') return SECURITY_MODE_ALIASES[mode];
  return isSecurityMode(mode) ? mode : fallback;
}

export function resolveSecurityMode({
  configuredMode,
  env = process.env as RuntimeEnv,
}: {
  configuredMode?: unknown;
  env?: RuntimeEnv;
} = {}): SecurityMode {
  const configured = clean(configuredMode);
  if (configured) return normalizeSecurityMode(configured);
  const envMode = clean(env.SECURITY_MODE || env.KCW_SECURITY_MODE);
  if (envMode) return normalizeSecurityMode(envMode);
  return 'controlled_hybrid';
}

function splitList(value: unknown): string[] {
  return clean(value)
    .split(/[,\s;]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostFromUrl(value: unknown): string {
  const raw = clean(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\./.test(host);
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isCustomerNetworkHost(host: string): boolean {
  return isPrivateIpv4(host)
    || host.endsWith('.internal')
    || host.endsWith('.corp')
    || host.endsWith('.local')
    || host.endsWith('.lan');
}

function matchesGatewayAllowlist(host: string, env: RuntimeEnv): boolean {
  if (!host) return false;
  return splitList(env.KCW_CUSTOMER_MODEL_GATEWAY_HOSTS).some((entry) => {
    const pattern = entry.replace(/^\*\./, '');
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

function providerSuggestsLocal(provider: string): boolean {
  return LOCAL_PROVIDER_IDS.has(provider) || provider.includes('/local');
}

function providerSuggestsCustomerGateway(provider: string): boolean {
  return provider.includes('customer') || provider.includes('gateway') || provider.includes('enterprise');
}

export function classifyModelProvider(
  config: Record<string, unknown> = {},
  { env = process.env as RuntimeEnv }: { env?: RuntimeEnv } = {},
): ProviderClass {
  const provider = lower(config.provider || config.kimiProvider || config.modelProvider);
  const host = hostFromUrl(config.baseUrl || config.kimiBaseUrl || config.apiBaseUrl);
  if (providerSuggestsLocal(provider) || isLoopbackHost(host)) return 'local';
  if (providerSuggestsCustomerGateway(provider) || matchesGatewayAllowlist(host, env) || isCustomerNetworkHost(host)) {
    return 'customer_gateway';
  }
  return 'external_provider';
}

export function decideModelProviderPolicy(
  config: Record<string, unknown> = {},
  {
    securityMode,
    env = process.env as RuntimeEnv,
  }: {
    securityMode?: unknown;
    env?: RuntimeEnv;
  } = {},
): ModelProviderPolicy {
  const mode = resolveSecurityMode({ configuredMode: securityMode ?? config.securityMode, env });
  const providerClass = classifyModelProvider(config, { env });
  let decision: ProviderPolicyDecision = 'allow';
  let reasonCode = 'model_provider_allowed';
  let reason = 'model provider is allowed by security mode';

  if ((mode === 'local_demo' || mode === 'local_strict' || mode === 'air_gap') && providerClass !== 'local') {
    decision = 'deny';
    reasonCode = `${mode}_model_must_be_local`;
    reason = `${mode} only allows local model providers`;
  } else if (mode === 'enterprise_local' && providerClass === 'external_provider') {
    decision = 'deny';
    reasonCode = 'enterprise_local_blocks_external_provider';
    reason = 'enterprise_local allows local models and customer gateways, not external providers';
  } else if (mode === 'controlled_hybrid' && providerClass === 'external_provider') {
    decision = 'needs_approval';
    reasonCode = 'controlled_hybrid_external_provider_needs_preview';
    reason = 'external provider requires outbound preview and audit in controlled_hybrid';
  }

  const provider = lower(config.provider || 'kimi-api') || 'kimi-api';
  const model = clean(config.model);
  const host = hostFromUrl(config.baseUrl);
  const audit: ModelProviderPolicy['audit'] = {
    securityMode: mode,
    providerClass,
    decision,
    reasonCode,
    provider,
    model,
    hasBaseUrl: Boolean(clean(config.baseUrl)),
  };
  if (host) audit.baseHost = host;
  return {
    allowed: decision !== 'deny',
    decision,
    securityMode: mode,
    providerClass,
    reasonCode,
    reason,
    audit,
  };
}

export function filterModelCandidatesBySecurityMode<T extends Record<string, unknown>>(
  candidates: T[],
  options: { securityMode?: unknown; env?: RuntimeEnv } = {},
): ModelCandidateFilter<T> {
  const decisions = candidates.map((config) => ({
    config,
    policy: decideModelProviderPolicy(config, options),
  }));
  const denied = decisions.filter((item) => !item.policy.allowed);
  return {
    candidates: decisions.filter((item) => item.policy.allowed).map((item) => item.config),
    decisions,
    denied,
  };
}

export function modelProviderPolicyError<T extends Record<string, unknown>>(denied: Array<CandidatePolicy<T>>): Error & {
  code: string;
  policyDecisions: ModelProviderPolicy[];
} {
  const first = denied[0]?.policy;
  const message = first
    ? `model provider blocked by ${first.securityMode}: ${first.reason}`
    : 'model provider blocked by security policy';
  const error = new Error(message) as Error & { code: string; policyDecisions: ModelProviderPolicy[] };
  error.name = 'ModelProviderPolicyError';
  error.code = 'MODEL_PROVIDER_POLICY_DENIED';
  error.policyDecisions = denied.map((item) => item.policy);
  return error;
}
