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
