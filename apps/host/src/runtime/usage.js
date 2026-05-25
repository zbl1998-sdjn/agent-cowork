const USD_PER_MILLION = 1_000_000;

/**
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} TokenUsage
 * @typedef {{ inputUsdPerMillionTokens: number, outputUsdPerMillionTokens: number }} UsageRate
 * @typedef {Record<string, UsageRate>} UsagePricing
 * @typedef {{ key?: string, label?: string, durationMs?: number }} TimingPhase
 * @typedef {{ startedAt?: string | number | null, finishedAt?: string | number | null, durationMs?: number | null, phases?: TimingPhase[] }} TimingInput
 */

/** @type {UsagePricing} */
export const DEFAULT_USAGE_PRICING = Object.freeze({
  default: { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  'moonshot-v1-8k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
  'moonshot-v1-32k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
  'moonshot-v1-128k': { inputUsdPerMillionTokens: 1.73, outputUsdPerMillionTokens: 1.73 },
});

/**
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function nonNegativeInteger(value) {
  return Math.max(0, Math.round(finiteNumber(value, 0)));
}

/**
 * @param {unknown} source
 * @param {string[]} keys
 * @returns {unknown}
 */
function pickNumber(source, keys) {
  if (!source || typeof source !== 'object') return 0;
  const record = /** @type {Record<string, unknown>} */ (source);
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return 0;
}

/**
 * @param {unknown} usage
 * @returns {TokenUsage}
 */
export function normalizeTokenUsage(usage) {
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

/**
 * @param {unknown[]} [usages]
 * @returns {TokenUsage}
 */
export function aggregateTokenUsage(usages = []) {
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const usage of usages) {
    const normal = normalizeTokenUsage(usage);
    totals.prompt_tokens += normal.prompt_tokens;
    totals.completion_tokens += normal.completion_tokens;
    totals.total_tokens += normal.total_tokens;
  }
  return totals;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value || '').trim();
}

/**
 * @param {unknown} model
 * @param {UsagePricing} pricing
 * @param {unknown} [provider]
 * @returns {UsageRate}
 */
function resolvePricing(model, pricing, provider = '') {
  if (!pricing || typeof pricing !== 'object') return DEFAULT_USAGE_PRICING.default;
  const modelKey = cleanText(model);
  const providerKey = cleanText(provider).toLowerCase();
  const combinedKey = providerKey && modelKey ? `${providerKey}:${modelKey}` : '';
  return pricing[combinedKey] || pricing[modelKey] || pricing[providerKey] || pricing.default || DEFAULT_USAGE_PRICING.default;
}

/**
 * @param {unknown} usage
 * @param {{ model?: string, provider?: string, currency?: string, pricing?: UsagePricing }} [options]
 * @returns {{ currency: string, input: number, output: number, total: number, estimated: true, source: 'local-estimate', model: string, provider: string }}
 */
export function estimateTokenCost(usage, {
  model = 'default',
  provider = 'unknown',
  currency = 'USD',
  pricing = DEFAULT_USAGE_PRICING,
} = {}) {
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

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function dateMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {TimingInput} [timing]
 * @returns {{ totalMs: number, phases: Array<{ key: string, label: string, durationMs: number, percent: number }>, unaccountedMs: number }}
 */
export function breakdownDuration({
  startedAt = null,
  finishedAt = null,
  durationMs = null,
  phases = [],
} = {}) {
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

/**
 * @param {{ usage?: unknown, usages?: unknown[] | null, model?: string, provider?: string, pricing?: UsagePricing, timing?: TimingInput }} [input]
 * @returns {{ schemaVersion: 1, provider: string, model: string, tokens: TokenUsage, cost: ReturnType<typeof estimateTokenCost>, duration: ReturnType<typeof breakdownDuration>, disclosure: { estimated: true, source: 'local-estimate', requiresSecret: false } }}
 */
export function buildUsageTransparency({
  usage = null,
  usages = null,
  model = 'default',
  provider = 'unknown',
  pricing = DEFAULT_USAGE_PRICING,
  timing = {},
} = {}) {
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
