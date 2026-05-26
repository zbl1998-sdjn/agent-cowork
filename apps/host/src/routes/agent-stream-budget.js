// @ts-check
import { createBudgetGuard } from '../runtime/budget-guard.js';

/**
 * @typedef {Record<string, unknown> & { model?: string, maxRunTokens?: unknown, maxSessionTokens?: unknown, maxRunCostUsd?: unknown, maxSessionCostUsd?: unknown, maxAgentWallClockMs?: unknown }} ModelConfig
 * @typedef {Record<string, unknown> & { budget?: unknown, maxRunTokens?: unknown, maxSessionTokens?: unknown, maxRunCostUsd?: unknown, maxSessionCostUsd?: unknown, maxWallClockMs?: unknown }} RequestBody
 * @typedef {{ body: unknown, kimiConfig: unknown, startedAt: Date, runTimeoutMs?: number }} AgentBudgetGuardOptions
 */

/** @param {unknown} value */
function positiveLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {unknown} configValue
 * @param {unknown} requestValue
 */
function tightestLimit(configValue, requestValue) {
  const fromConfig = positiveLimit(configValue);
  const fromRequest = positiveLimit(requestValue);
  if (fromConfig !== null && fromRequest !== null) return Math.min(fromConfig, fromRequest);
  return fromConfig ?? fromRequest ?? undefined;
}

/**
 * @param {unknown} body
 * @param {unknown} kimiConfig
 */
function budgetInputs(body, kimiConfig) {
  const requestBody = body && typeof body === 'object' ? /** @type {RequestBody} */ (body) : {};
  const config = kimiConfig && typeof kimiConfig === 'object' ? /** @type {ModelConfig} */ (kimiConfig) : {};
  const requestBudget = requestBody.budget && typeof requestBody.budget === 'object'
    ? /** @type {Record<string, unknown>} */ (requestBody.budget)
    : {};
  return { requestBody, config, requestBudget };
}

/**
 * @param {unknown} body
 * @param {unknown} kimiConfig
 */
export function resolveAgentRunTimeoutMs(body, kimiConfig) {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return tightestLimit(config.maxAgentWallClockMs, requestBudget.maxWallClockMs ?? requestBody.maxWallClockMs);
}

/** @param {AgentBudgetGuardOptions} options */
export function createAgentBudgetGuard({
  body,
  kimiConfig,
  startedAt,
  runTimeoutMs,
}) {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return createBudgetGuard({
    maxRunTokens: tightestLimit(config.maxRunTokens, requestBudget.maxRunTokens ?? requestBody.maxRunTokens),
    maxSessionTokens: tightestLimit(config.maxSessionTokens, requestBudget.maxSessionTokens ?? requestBody.maxSessionTokens),
    maxRunCostUsd: tightestLimit(config.maxRunCostUsd, requestBudget.maxRunCostUsd ?? requestBody.maxRunCostUsd),
    maxSessionCostUsd: tightestLimit(config.maxSessionCostUsd, requestBudget.maxSessionCostUsd ?? requestBody.maxSessionCostUsd),
    maxWallClockMs: runTimeoutMs,
    model: config.model,
    startedAtMs: startedAt.getTime(),
  });
}
