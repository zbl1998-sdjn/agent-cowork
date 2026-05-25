// @ts-check

import { estimateTokenCost, normalizeTokenUsage } from './usage.js';

/**
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} TokenUsage
 * @typedef {{ inputUsdPerMillionTokens: number, outputUsdPerMillionTokens: number }} UsageRate
 * @typedef {Record<string, UsageRate>} UsagePricing
 * @typedef {{
 *   maxRunTokens?: number,
 *   maxSessionTokens?: number,
 *   maxRunCostUsd?: number,
 *   maxSessionCostUsd?: number,
 *   maxWallClockMs?: number,
 *   sessionUsage?: unknown,
 *   sessionCostUsd?: number,
 *   model?: string,
 *   pricing?: UsagePricing,
 *   startedAtMs?: number,
 *   now?: () => number,
 * }} BudgetGuardOptions
 * @typedef {{
 *   runUsage: TokenUsage,
 *   sessionUsage: TokenUsage,
 *   runCostUsd: number,
 *   sessionCostUsd: number,
 *   elapsedMs: number,
 *   model: string,
 * }} BudgetSnapshot
 * @typedef {{
 *   shouldAbort: boolean,
 *   limit: string,
 *   actual: number,
 *   maximum: number,
 *   reason: string,
 *   snapshot: BudgetSnapshot,
 * }} BudgetDecision
 */

/** @returns {TokenUsage} */
function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** @param {unknown} value @returns {number | null} */
function positiveLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {number} value @returns {number} */
function roundCost(value) {
  return Number(value.toFixed(8));
}

/** @param {TokenUsage} target @param {TokenUsage} usage */
function addUsage(target, usage) {
  target.prompt_tokens += usage.prompt_tokens;
  target.completion_tokens += usage.completion_tokens;
  target.total_tokens += usage.total_tokens;
}

/**
 * @param {Partial<BudgetDecision>} partial
 * @param {BudgetSnapshot} snapshot
 * @returns {BudgetDecision}
 */
function makeDecision(partial, snapshot) {
  return {
    shouldAbort: false,
    limit: '',
    actual: 0,
    maximum: 0,
    reason: '',
    snapshot,
    ...partial,
  };
}

export class BudgetGuard {
  /** @param {BudgetGuardOptions} [options] */
  constructor(options = {}) {
    this.maxRunTokens = positiveLimit(options.maxRunTokens);
    this.maxSessionTokens = positiveLimit(options.maxSessionTokens);
    this.maxRunCostUsd = positiveLimit(options.maxRunCostUsd);
    this.maxSessionCostUsd = positiveLimit(options.maxSessionCostUsd);
    this.maxWallClockMs = positiveLimit(options.maxWallClockMs);
    this.now = options.now || Date.now;
    this.startedAtMs = Number.isFinite(Number(options.startedAtMs)) ? Number(options.startedAtMs) : this.now();
    this.model = String(options.model || 'default');
    this.pricing = options.pricing;
    this.runUsage = emptyUsage();
    this.sessionUsage = normalizeTokenUsage(options.sessionUsage);
    this.runCostUsd = 0;
    this.sessionBaseCostUsd = positiveLimit(options.sessionCostUsd)
      ?? estimateTokenCost(this.sessionUsage, { model: this.model, pricing: this.pricing }).total;
    this.sessionCostUsd = this.sessionBaseCostUsd;
    this.lastDecision = makeDecision({}, this.snapshot());
  }

  /** @returns {BudgetSnapshot} */
  snapshot() {
    return {
      runUsage: { ...this.runUsage },
      sessionUsage: { ...this.sessionUsage },
      runCostUsd: this.runCostUsd,
      sessionCostUsd: this.sessionCostUsd,
      elapsedMs: Math.max(0, Math.round(this.now() - this.startedAtMs)),
      model: this.model,
    };
  }

  /**
   * @param {unknown} usage
   * @returns {BudgetDecision}
   */
  recordUsage(usage) {
    const normal = normalizeTokenUsage(usage);
    addUsage(this.runUsage, normal);
    addUsage(this.sessionUsage, normal);
    this.runCostUsd = estimateTokenCost(this.runUsage, { model: this.model, pricing: this.pricing }).total;
    this.sessionCostUsd = roundCost(this.sessionBaseCostUsd + this.runCostUsd);
    return this.check();
  }

  /** @returns {BudgetDecision} */
  check() {
    const snap = this.snapshot();
    const checks = [
      { limit: 'maxWallClockMs', actual: snap.elapsedMs, maximum: this.maxWallClockMs, label: 'wall-clock budget' },
      { limit: 'maxRunTokens', actual: snap.runUsage.total_tokens, maximum: this.maxRunTokens, label: 'run token budget' },
      { limit: 'maxSessionTokens', actual: snap.sessionUsage.total_tokens, maximum: this.maxSessionTokens, label: 'session token budget' },
      { limit: 'maxRunCostUsd', actual: snap.runCostUsd, maximum: this.maxRunCostUsd, label: 'run cost budget' },
      { limit: 'maxSessionCostUsd', actual: snap.sessionCostUsd, maximum: this.maxSessionCostUsd, label: 'session cost budget' },
    ];
    for (const check of checks) {
      if (check.maximum !== null && check.actual > check.maximum) {
        this.lastDecision = makeDecision({
          shouldAbort: true,
          limit: check.limit,
          actual: check.actual,
          maximum: check.maximum,
          reason: `${check.label} exceeded (${check.actual}/${check.maximum})`,
        }, snap);
        return this.lastDecision;
      }
    }
    this.lastDecision = makeDecision({}, snap);
    return this.lastDecision;
  }

  /**
   * @param {BudgetDecision} [budgetDecision]
   * @returns {string}
   */
  stopMessage(budgetDecision = this.lastDecision) {
    const reason = budgetDecision.reason || 'budget exceeded';
    return `本轮已触发预算保护，已安全停止继续执行：${reason}。请提高预算、缩小任务范围，或让我在新的预算下继续。`;
  }
}

/**
 * @param {BudgetGuardOptions} [options]
 * @returns {BudgetGuard}
 */
export function createBudgetGuard(options = {}) {
  return new BudgetGuard(options);
}
