// 韧性助手(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:超时、带退避的重试、分层降级链。与熔断器(circuit-breaker.js)一起实现优雅降级:调用限时、
//       瞬时故障重试若干次、最终经 fallback 层降级而非硬失败。依赖:无。导出:TimeoutError + withTimeout/retry/fallback。

export class TimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(ms: number, label?: string) {
    super(`timed out after ${ms}ms${label ? ` (${label})` : ''}`);
    this.name = 'TimeoutError';
  }
}

// 如果 promise 在 ms 内没有 settle,立即拒绝调用方等待;底层任务是否取消由调用方传入 AbortSignal 决定。
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

// 指数退避 + jitter 重试;shouldRetry 用于跳过非瞬时错误,sleep 可注入以保证测试不等待真实时间。
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

// 按顺序尝试降级层,返回第一个成功结果;只有所有层失败时才抛出带 errors 的 FallbackExhaustedError。
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
        try { onLayerError(err, i); } catch { /* 观察者异常不能中断降级链。 */ }
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
