// Security mode and model-provider classification (host L0 security).
// Keep this module pure so L1/L2 callers can share the same fail-closed rules.
import { isConfidentialMode } from './confidential.js';
import {
  isCustomerGatewayHostAllowed,
  isPrivateModelHost,
  type RuntimeEnv,
} from './model-gateway-policy.js';

export { isCustomerGatewayHostAllowed } from './model-gateway-policy.js';
export type { RuntimeEnv } from './model-gateway-policy.js';

export const SECURITY_MODES = Object.freeze([
  'local_demo',
  'local_strict',
  'enterprise_local',
  'air_gap',
  'controlled_hybrid',
] as const);

export type SecurityMode = typeof SECURITY_MODES[number];
export type LegacySecurityMode = 'enterprise_hybrid' | 'saas_opt_in';
export type ProviderClass = 'local' | 'customer_gateway' | 'external_provider';
export type ProviderPolicyDecision = 'allow' | 'deny' | 'needs_approval';

export type ModelBaseUrlInspection = {
  provided: boolean;
  normalized: string;
  protocol: string;
  host: string;
  loopback: boolean;
  issue?: {
    reasonCode: string;
    reason: string;
  };
};

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

/** 「严格本地」模式(local_demo/local_strict/air_gap):唯一权威定义,供 egress-gateway/
 * sandbox 等 L0/L1 消费方共用同一口径——散落的字面量比较(如只写 `=== 'local_strict'`)
 * 容易漏掉 air_gap 这个更严格的模式(dogfood 实测踩过:sandbox 的高风险工具阻断策略就
 * 因此对 air_gap 完全失效)。 */
export function isStrictLocalMode(mode: SecurityMode): boolean {
  return mode === 'local_demo' || mode === 'local_strict' || mode === 'air_gap';
}

export function resolveSecurityMode({
  configuredMode,
  env = process.env as RuntimeEnv,
}: {
  configuredMode?: unknown;
  env?: RuntimeEnv;
} = {}): SecurityMode {
  // 机密模式总开关优先级最高:强制 air_gap,任何 configuredMode/env 模式都不能削弱。
  // 放在这里让所有 L0 策略消费方(模型 provider 策略/工具策略/出口网关)自动继承。
  if (isConfidentialMode(env)) return 'air_gap';
  const configured = clean(configuredMode);
  if (configured) return normalizeSecurityMode(configured);
  const envMode = clean(env.SECURITY_MODE || env.ACW_SECURITY_MODE || env.KCW_SECURITY_MODE);
  if (envMode) return normalizeSecurityMode(envMode);
  return 'controlled_hybrid';
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\./.test(host);
}

function isIpv4LinkLocal(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 169
    && parts[1] === 254;
}

function isIpv6LinkLocal(host: string): boolean {
  const unwrapped = host.replace(/^\[|\]$/g, '').toLowerCase();
  const firstHextet = Number.parseInt(unwrapped.split(':', 1)[0] || '', 16);
  return Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf;
}

const METADATA_HOSTS = new Set([
  '100.100.100.200',
  'fd00:ec2::254',
  '[fd00:ec2::254]',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  'metadata.azure.internal',
  'metadata.google',
  'metadata.google.internal',
]);

function isUnsafeModelDestination(host: string): boolean {
  return !host
    || host === '0.0.0.0'
    || host === '::'
    || host === '[::]'
    || isIpv4LinkLocal(host)
    || isIpv6LinkLocal(host)
    || METADATA_HOSTS.has(host);
}

function inspectionIssue(
  provided: boolean,
  reasonCode: string,
  reason: string,
  fields: Partial<Omit<ModelBaseUrlInspection, 'provided' | 'issue'>> = {},
): ModelBaseUrlInspection {
  return {
    provided,
    normalized: fields.normalized || '',
    protocol: fields.protocol || '',
    host: fields.host || '',
    loopback: fields.loopback === true,
    issue: { reasonCode, reason },
  };
}

/** Parse once with the WHATWG URL implementation so classification and route
 * normalization agree. Destination safety remains explicit policy evidence. */
export function inspectModelBaseUrl(value: unknown): ModelBaseUrlInspection {
  const raw = clean(value);
  if (!raw) return { provided: false, normalized: '', protocol: '', host: '', loopback: false };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return inspectionIssue(true, 'model_base_url_invalid', 'model base URL must be an absolute http:// or https:// URL');
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return inspectionIssue(true, 'model_base_url_unsupported_protocol', 'model base URL must use http:// or https://', {
      protocol,
      host,
    });
  }
  if (parsed.username || parsed.password) {
    return inspectionIssue(true, 'model_base_url_credentials_not_allowed', 'model base URL must not contain embedded credentials', {
      protocol,
      host,
    });
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const normalized = parsed.toString().replace(/\/$/, '');
  const loopback = isLoopbackHost(host);
  if (isUnsafeModelDestination(host)) {
    return inspectionIssue(true, 'model_base_url_unsafe_destination', 'model base URL targets a metadata, link-local, or unspecified address', {
      normalized,
      protocol,
      host,
      loopback,
    });
  }
  return { provided: true, normalized, protocol, host, loopback };
}

/** Normalize syntax and protocol. Unsafe destinations are returned in canonical
 * form so the policy layer can deny them with a stable reason code. */
export function normalizeModelBaseUrl(value: unknown): string {
  const inspection = inspectModelBaseUrl(value);
  if (inspection.issue && inspection.issue.reasonCode !== 'model_base_url_unsafe_destination') {
    const error = new TypeError(inspection.issue.reason) as TypeError & { code: string };
    error.code = inspection.issue.reasonCode;
    throw error;
  }
  return inspection.normalized;
}

function providerSuggestsLocal(provider: string): boolean {
  return LOCAL_PROVIDER_IDS.has(provider) || provider.includes('/local');
}

function configuredBaseUrl(config: Record<string, unknown>): unknown {
  return config.baseUrl || config.modelBaseUrl || config.apiBaseUrl;
}

export function classifyModelProvider(
  config: Record<string, unknown> = {},
  { env = process.env as RuntimeEnv }: { env?: RuntimeEnv } = {},
): ProviderClass {
  const provider = lower(config.provider || config.kimiProvider || config.modelProvider);
  const endpoint = inspectModelBaseUrl(configuredBaseUrl(config));
  if (endpoint.provided) {
    if (endpoint.issue) return 'external_provider';
    if (endpoint.loopback) return 'local';
    if (isCustomerGatewayHostAllowed(endpoint.host, env)) {
      return 'customer_gateway';
    }
    return 'external_provider';
  }
  if (providerSuggestsLocal(provider)) return 'local';
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
  const endpoint = inspectModelBaseUrl(configuredBaseUrl(config));
  const providerClass = classifyModelProvider(config, { env });
  const unallowlistedPrivateDestination = endpoint.provided
    && !endpoint.issue
    && isPrivateModelHost(endpoint.host)
    && !isCustomerGatewayHostAllowed(endpoint.host, env);
  let decision: ProviderPolicyDecision = 'allow';
  let reasonCode = 'model_provider_allowed';
  let reason = 'model provider is allowed by security mode';

  if (endpoint.issue) {
    decision = 'deny';
    reasonCode = endpoint.issue.reasonCode;
    reason = endpoint.issue.reason;
  } else if (unallowlistedPrivateDestination) {
    decision = 'deny';
    reasonCode = 'model_base_url_private_destination_not_allowlisted';
    reason = 'private or internal model destinations require an explicit administrator gateway allowlist';
  } else if ((mode === 'local_demo' || mode === 'local_strict' || mode === 'air_gap') && providerClass !== 'local') {
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
  const audit: ModelProviderPolicy['audit'] = {
    securityMode: mode,
    providerClass,
    decision,
    reasonCode,
    provider,
    model,
    hasBaseUrl: endpoint.provided,
  };
  if (endpoint.host) audit.baseHost = endpoint.host;
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
