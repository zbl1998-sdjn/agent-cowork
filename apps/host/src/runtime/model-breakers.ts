// 模型熔断器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:为「每个模型/提供商端点」维护独立熔断器,使某个模型连续故障时只熔断它、不波及其余;提供聚合状态。
//       是 agent 模型调用共享的运行时保护(故被 kimi/agent 按既有架构豁免上引)。依赖:同层 circuit-breaker。
import { CircuitBreaker } from './circuit-breaker.js';
import type { CircuitBreakerStats } from './circuit-breaker.js';

export type KimiConfigLike = { provider?: unknown; baseUrl?: unknown; model?: unknown };

const MODEL_BREAKERS = new Map<string, CircuitBreaker>();

export function modelProvider(kimiConfig: KimiConfigLike | null | undefined): string {
  return String((kimiConfig && kimiConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

export function modelBreaker(kimiConfig: KimiConfigLike | null | undefined): CircuitBreaker {
  const key = `${modelProvider(kimiConfig)}|${kimiConfig && kimiConfig.baseUrl}|${kimiConfig && kimiConfig.model}`;
  let breaker = MODEL_BREAKERS.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: `model:${key}`, failureThreshold: 4, cooldownMs: 15000 });
    MODEL_BREAKERS.set(key, breaker);
  }
  return breaker;
}

export function modelBreakerStats(): CircuitBreakerStats[] {
  return [...MODEL_BREAKERS.values()].map((b) => b.stats());
}
