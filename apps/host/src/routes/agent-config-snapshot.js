// @ts-check

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {unknown} body
 * @param {unknown} kimiConfig
 * @returns {{ baseUrl: unknown, model: unknown, timeoutMs: unknown, maxTokens: unknown, temperature: number | undefined, planMode: boolean, developerMode: boolean, verify: boolean, maxSteps: number }}
 */
export function buildAgentConfigSnapshot(body, kimiConfig) {
  const requestBody = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
  const config = kimiConfig && typeof kimiConfig === 'object' ? /** @type {Record<string, unknown>} */ (kimiConfig) : {};
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: finiteNumber(config.temperature),
    planMode: requestBody.planMode === true,
    developerMode: requestBody.developerMode === true || requestBody.mode === 'developer',
    verify: requestBody.verify === true || requestBody.thinking === 'deep',
    maxSteps: Math.min(Math.max(Number(requestBody.maxSteps) || 8, 1), 16),
  };
}
