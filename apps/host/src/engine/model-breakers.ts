// 模型熔断器(host · L1 领域层 · engine)
// ---------------------------------------------------------------------------
// 职责:为「每个模型/提供商端点」维护独立熔断器,使某个模型连续故障时只熔断它、不波及其余;提供聚合状态。
//       是 Kimi 模型调用共享的领域保护。依赖:L0 util/circuit-breaker。
import { CircuitBreaker } from '../util/circuit-breaker.js';
import type { CircuitBreakerStats } from '../util/circuit-breaker.js';

export type ModelConfigLike = { provider?: unknown; baseUrl?: unknown; model?: unknown };

const MODEL_BREAKERS = new Map<string, CircuitBreaker>();

export function modelProvider(modelConfig: ModelConfigLike | null | undefined): string {
  return String((modelConfig && modelConfig.provider) || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

export function modelBreaker(modelConfig: ModelConfigLike | null | undefined): CircuitBreaker {
  const key = `${modelProvider(modelConfig)}|${modelConfig && modelConfig.baseUrl}|${modelConfig && modelConfig.model}`;
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
