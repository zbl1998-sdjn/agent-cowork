// 用量与计费(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把模型 token 用量按各模型单价(美元/百万 token)折算成费用,并归一化耗时/分阶段计时。
//       供运行记录与可观测展示「这次花了多少钱、用了多久」。纯计算、无副作用。
// 依赖:无。导出:DEFAULT_USAGE_PRICING + 用量/计时计算函数。
const USD_PER_MILLION = 1_000_000;

export type TokenUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
export type UsageRate = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
export type UsagePricing = Record<string, UsageRate>;
export type TimingPhase = { key?: string; label?: string; durationMs?: number };
export type TimingInput = {
  startedAt?: string | number | null;
  finishedAt?: string | number | null;
  durationMs?: number | null;
  phases?: TimingPhase[];
};
export type TokenCostEstimate = {
  currency: string;
  input: number;
  output: number;
  total: number;
  estimated: true;
  source: 'local-estimate';
  model: string;
  provider: string;
};
export type DurationBreakdown = {
  totalMs: number;
  phases: Array<{ key: string; label: string; durationMs: number; percent: number }>;
  unaccountedMs: number;
};
export type UsageTransparency = {
  schemaVersion: 1;
  provider: string;
  model: string;
  tokens: TokenUsage;
  cost: TokenCostEstimate;
  duration: DurationBreakdown;
  disclosure: { estimated: true; source: 'local-estimate'; requiresSecret: false };
};

export const DEFAULT_USAGE_PRICING: UsagePricing = Object.freeze({
  default: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  'moonshot-v1-8k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
  'moonshot-v1-32k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
  'moonshot-v1-128k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
});

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.round(finiteNumber(value, 0)));
}

function pickNumber(source: unknown, keys: string[]): unknown {
  if (!source || typeof source !== 'object') return 0;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return 0;
}

export function normalizeTokenUsage(usage: unknown): TokenUsage {
  const promptTokens = nonNegativeInteger(pickNumber(usage, ['prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens']));
  const completionTokens = nonNegativeInteger(pickNumber(usage, ['completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens']));
  const suppliedTotal = nonNegativeInteger(pickNumber(usage, ['total_tokens', 'totalTokens']));
  const totalTokens = suppliedTotal || promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

export function aggregateTokenUsage(usages: unknown[] = []): TokenUsage {
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const usage of usages) {
    const normal = normalizeTokenUsage(usage);
    totals.prompt_tokens += normal.prompt_tokens;
    totals.completion_tokens += normal.completion_tokens;
    totals.total_tokens += normal.total_tokens;
  }
  return totals;
}

function cleanText(value: unknown): string {
  return String(value || '').trim();
}

function resolvePricing(model: unknown, pricing: UsagePricing, provider: unknown = ''): UsageRate {
  if (!pricing || typeof pricing !== 'object') return DEFAULT_USAGE_PRICING.default;
  const modelKey = cleanText(model);
  const providerKey = cleanText(provider).toLowerCase();
  const combinedKey = providerKey && modelKey ? `${providerKey}:${modelKey}` : '';
  return pricing[combinedKey] || pricing[modelKey] || pricing[providerKey] || pricing.default || DEFAULT_USAGE_PRICING.default;
}

export function estimateTokenCost(usage: unknown, {
  model = 'default',
  provider = 'unknown',
  currency = 'USD',
  pricing = DEFAULT_USAGE_PRICING,
}: { model?: string; provider?: string; currency?: string; pricing?: UsagePricing } = {}): TokenCostEstimate {
  const tokens = normalizeTokenUsage(usage);
  const rate = resolvePricing(model, pricing, provider);
  const inputUsd = tokens.prompt_tokens * finiteNumber(rate.inputUsdPerMillionTokens, 0) / USD_PER_MILLION;
  const outputUsd = tokens.completion_tokens * finiteNumber(rate.outputUsdPerMillionTokens, 0) / USD_PER_MILLION;
  const totalUsd = inputUsd + outputUsd;
  return {
    currency,
    input: Number(inputUsd.toFixed(8)),
    output: Number(outputUsd.toFixed(8)),
    total: Number(totalUsd.toFixed(8)),
    estimated: true,
    source: 'local-estimate',
    model: cleanText(model) || 'default',
    provider: cleanText(provider).toLowerCase() || 'unknown',
  };
}

function dateMs(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

export function breakdownDuration({
  startedAt = null,
  finishedAt = null,
  durationMs = null,
  phases = [],
}: TimingInput = {}): DurationBreakdown {
  const startedMs = dateMs(startedAt);
  const finishedMs = dateMs(finishedAt);
  const computedTotal = startedMs !== null && finishedMs !== null ? Math.max(0, finishedMs - startedMs) : null;
  const totalMs = nonNegativeInteger(durationMs ?? computedTotal ?? 0);
  const normalizedPhases = Array.isArray(phases) ? phases.map((phase) => {
    const ms = nonNegativeInteger(phase && phase.durationMs);
    return {
      key: String((phase && phase.key) || 'unknown'),
      label: String((phase && phase.label) || (phase && phase.key) || 'Unknown'),
      durationMs: ms,
      percent: totalMs > 0 ? Number(((ms / totalMs) * 100).toFixed(1)) : 0,
    };
  }) : [];
  const accountedMs = normalizedPhases.reduce((sum, phase) => sum + phase.durationMs, 0);
  const unaccountedMs = Math.max(0, totalMs - accountedMs);
  return {
    totalMs,
    phases: normalizedPhases,
    unaccountedMs,
  };
}

export function buildUsageTransparency({
  usage = null,
  usages = null,
  model = 'default',
  provider = 'unknown',
  pricing = DEFAULT_USAGE_PRICING,
  timing = {},
}: { usage?: unknown; usages?: unknown[] | null; model?: string; provider?: string; pricing?: UsagePricing; timing?: TimingInput } = {}): UsageTransparency {
  const tokens = Array.isArray(usages) ? aggregateTokenUsage(usages) : normalizeTokenUsage(usage);
  const cleanProvider = cleanText(provider).toLowerCase() || 'unknown';
  const cost = estimateTokenCost(tokens, { model, provider: cleanProvider, pricing });
  const duration = breakdownDuration(timing);
  return {
    schemaVersion: 1,
    provider: cleanProvider,
    model: cleanText(model) || 'default',
    tokens,
    cost,
    duration,
    disclosure: {
      estimated: true,
      source: 'local-estimate',
      requiresSecret: false,
    },
  };
}
