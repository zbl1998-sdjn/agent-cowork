// 韧性助手(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:超时、带退避的重试、分层降级链。与熔断器(circuit-breaker.js)一起实现优雅降级:调用限时、
//       瞬时故障重试若干次、最终经 fallback 层降级而非硬失败。依赖:无。导出:TimeoutError + withTimeout/retry/fallback。
//
// Resilience helpers — timeout, retry-with-backoff, and a layered fallback chain.
// Together with the circuit breaker (circuit-breaker.js) these implement graceful
// degradation: a call is bounded in time, retried a few times for transient
// faults, and finally degraded through fallback layers instead of hard-failing.

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(ms: number, label?: string) {
    super(`timed out after ${ms}ms${label ? ` (${label})` : ''}`);
    this.name = 'TimeoutError';
  }
}

// Reject if `promise` doesn't settle within `ms`. The underlying work isn't
// cancelled (pass an AbortSignal to the worker if you need that); this just stops
// the caller from waiting forever.
export function withTimeout<T>(promise: Promise<T> | T, ms: number, label?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Retry `fn` with exponential backoff + jitter. `shouldRetry(err, attempt)` lets
// callers skip retries for non-transient errors (e.g. 4xx, auth). `sleep` is
// injectable so tests run instantly.
export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void> | void;
  random?: () => number;
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T> | T,
  {
    retries = 2,
    baseDelayMs = 200,
    factor = 2,
    jitter = true,
    shouldRetry = () => true,
    sleep = defaultSleep,
    random = Math.random,
  }: RetryOptions = {},
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      let delay = baseDelayMs * Math.pow(factor, attempt);
      if (jitter) delay = Math.round(delay * (0.5 + random() * 0.5));
      await sleep(delay);
      attempt += 1;
    }
  }
}

// Try each layer in order; return the first success. This is the "3-layer
// fallback" primitive: e.g. [primaryModel, degradedModel, deterministicFallback].
// Throws FallbackExhaustedError (with .errors) only if every layer fails.
export type FallbackExhaustedError = Error & { code?: string; errors?: unknown[] };

export async function fallbackChain<T>(
  layers: Array<(index: number) => Promise<T> | T>,
  { onLayerError }: { onLayerError?: (err: unknown, index: number) => void } = {},
): Promise<T> {
  const errors: unknown[] = [];
  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    if (!layer) continue;
    try {
      return await layer(i);
    } catch (err) {
      errors.push(err);
      if (typeof onLayerError === 'function') {
        try { onLayerError(err, i); } catch { /* observer must not break the chain */ }
      }
    }
  }
  const agg = new Error(
    'all fallback layers failed: ' + errors.map((e) => (e instanceof Error && e.message) || String(e)).join(' | '),
  ) as FallbackExhaustedError;
  agg.name = 'FallbackExhaustedError';
  agg.code = 'FALLBACK_EXHAUSTED';
  agg.errors = errors;
  throw agg;
}
