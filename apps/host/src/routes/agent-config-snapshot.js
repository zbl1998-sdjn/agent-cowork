// @ts-check

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** @param {unknown} value */
function fallbackSummaries(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
    return {
      provider: source.provider,
      baseUrl: source.baseUrl,
      model: source.model,
      hasKey: Boolean(source.apiKey),
    };
  });
}

/**
 * @param {unknown} body
 * @param {unknown} kimiConfig
 * @returns {{ provider: unknown, baseUrl: unknown, model: unknown, timeoutMs: unknown, maxTokens: unknown, temperature: number | undefined, fallbacks: Array<{ provider: unknown, baseUrl: unknown, model: unknown, hasKey: boolean }>, planMode: boolean, developerMode: boolean, verify: boolean, maxSteps: number }}
 */
export function buildAgentConfigSnapshot(body, kimiConfig) {
  const requestBody = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  const config = kimiConfig && typeof kimiConfig === 'object' ? /** @type {Record<string, unknown>} */ (kimiConfig) : {};
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: finiteNumber(config.temperature),
    fallbacks: fallbackSummaries(config.fallbacks),
    planMode: requestBody.planMode === true,
    developerMode: requestBody.developerMode === true || requestBody.mode === 'developer',
    verify: requestBody.verify === true || requestBody.thinking === 'deep',
    maxSteps: Math.min(Math.max(Number(requestBody.maxSteps) || 8, 1), 16),
  };
}
