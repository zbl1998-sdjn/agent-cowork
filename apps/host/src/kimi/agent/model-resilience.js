import { CircuitBreaker } from '../../runtime/circuit-breaker.js';
import { redactText } from '../../security/redaction.js';

const MODEL_BREAKERS = new Map();

function modelBreaker(kimiConfig) {
  const key = `${kimiConfig && kimiConfig.baseUrl}|${kimiConfig && kimiConfig.model}`;
  let breaker = MODEL_BREAKERS.get(key);
  if (!breaker) {
    breaker = new CircuitBreaker({ name: `model:${key}`, failureThreshold: 4, cooldownMs: 15000 });
    MODEL_BREAKERS.set(key, breaker);
  }
  return breaker;
}

export function modelBreakerStats() {
  return [...MODEL_BREAKERS.values()].map((b) => b.stats());
}

export async function callModelResilient(modelCall, callArgs, { kimiConfig, timeoutMs = 60000 } = {}) {
  return modelBreaker(kimiConfig).run(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 60000));
    try {
      return await modelCall({ ...callArgs, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  });
}

export function friendlyAgentError(err, context) {
  const trace = context && context.traceId ? `（追踪号 ${context.traceId}）` : '';
  if (err && err.code === 'CIRCUIT_OPEN') return `模型服务暂时不可用，已启用熔断保护，请稍后重试${trace}`;
  if (err && err.code === 'ETIMEDOUT') return `模型响应超时，请稍后重试${trace}`;
  const msg = redactText((err && err.message) || '发生未知错误');
  return `${msg}${trace ? ' ' + trace : ''}`;
}
