// 模型熔断器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为「每个模型/提供商端点」维护独立熔断器,使某个模型连续故障时只熔断它、不波及其余;提供聚合状态。
//       是 agent 模型调用共享的运行时保护(故被 kimi/agent 按既有架构豁免上引)。依赖:同层 circuit-breaker。
// @ts-check
import { CircuitBreaker } from './circuit-breaker.js';

/**
 * @typedef {{ provider?: unknown, baseUrl?: unknown, model?: unknown }} KimiConfigLike
 * @typedef {ReturnType<CircuitBreaker['stats']>} ModelBreakerStats
 */

/** @type {Map<string, CircuitBreaker>} */
const MODEL_BREAKERS = new Map();

/** @param {KimiConfigLike | null | undefined} kimiConfig @returns {string} */
export function modelProvider(kimiConfig) {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

/** @param {KimiConfigLike | null | undefined} kimiConfig @returns {CircuitBreaker} */
export function modelBreaker(kimiConfig) {
  const key = `${modelProvider(kimiConfig)}|${kimiConfig && kimiConfig.baseUrl}|${kimiConfig && kimiConfig.model}`;
  let breaker = MODEL_BREAKERS.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: `model:${key}`, failureThreshold: 4, cooldownMs: 15000 });
    MODEL_BREAKERS.set(key, breaker);
  }
  return breaker;
}

/** @returns {ModelBreakerStats[]} */
export function modelBreakerStats() {
  return [...MODEL_BREAKERS.values()].map((b) => b.stats());
}
