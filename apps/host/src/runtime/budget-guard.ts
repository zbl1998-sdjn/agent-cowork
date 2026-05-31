// 预算护栏(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为 Agent 运行设「token/费用预算」护栏——累计用量,逼近/超过上限时给出告警或阻断,防止单次运行失控烧钱。
// 依赖:同层 usage。导出:预算护栏工厂(createBudgetGuard)。

import { estimateTokenCost, normalizeTokenUsage } from './usage.js';
import type { TokenUsage, UsagePricing } from './usage.js';

export type BudgetGuardOptions = {
  maxRunTokens?: number;
  maxSessionTokens?: number;
  maxRunCostUsd?: number;
  maxSessionCostUsd?: number;
  maxWallClockMs?: number;
  sessionUsage?: unknown;
  sessionCostUsd?: number;
  model?: string;
  pricing?: UsagePricing;
  startedAtMs?: number;
  now?: () => number;
};
export type BudgetSnapshot = {
  runUsage: TokenUsage;
  sessionUsage: TokenUsage;
  runCostUsd: number;
  sessionCostUsd: number;
  elapsedMs: number;
  model: string;
};
export type BudgetDecision = {
  shouldAbort: boolean;
  limit: string;
  actual: number;
  maximum: number;
  reason: string;
  snapshot: BudgetSnapshot;
};

function emptyUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function positiveLimit(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function addUsage(target: TokenUsage, usage: TokenUsage): void {
  target.prompt_tokens += usage.prompt_tokens;
  target.completion_tokens += usage.completion_tokens;
  target.total_tokens += usage.total_tokens;
}

function makeDecision(partial: Partial<BudgetDecision>, snapshot: BudgetSnapshot): BudgetDecision {
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
  maxRunTokens: number | null;
  maxSessionTokens: number | null;
  maxRunCostUsd: number | null;
  maxSessionCostUsd: number | null;
  maxWallClockMs: number | null;
  now: () => number;
  startedAtMs: number;
  model: string;
  pricing?: UsagePricing;
  runUsage: TokenUsage;
  sessionUsage: TokenUsage;
  runCostUsd: number;
  sessionBaseCostUsd: number;
  sessionCostUsd: number;
  lastDecision: BudgetDecision;

  constructor(options: BudgetGuardOptions = {}) {
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

  snapshot(): BudgetSnapshot {
    return {
      runUsage: { ...this.runUsage },
      sessionUsage: { ...this.sessionUsage },
      runCostUsd: this.runCostUsd,
      sessionCostUsd: this.sessionCostUsd,
      elapsedMs: Math.max(0, Math.round(this.now() - this.startedAtMs)),
      model: this.model,
    };
  }

  recordUsage(usage: unknown): BudgetDecision {
    const normal = normalizeTokenUsage(usage);
    addUsage(this.runUsage, normal);
    addUsage(this.sessionUsage, normal);
    this.runCostUsd = estimateTokenCost(this.runUsage, { model: this.model, pricing: this.pricing }).total;
    this.sessionCostUsd = roundCost(this.sessionBaseCostUsd + this.runCostUsd);
    return this.check();
  }

  check(): BudgetDecision {
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

  stopMessage(budgetDecision: BudgetDecision = this.lastDecision): string {
    const reason = budgetDecision.reason || 'budget exceeded';
    return `本轮已触发预算保护，已安全停止继续执行：${reason}。请提高预算、缩小任务范围，或让我在新的预算下继续。`;
  }
}

export function createBudgetGuard(options: BudgetGuardOptions = {}): BudgetGuard {
  return new BudgetGuard(options);
}
