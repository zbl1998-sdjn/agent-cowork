// Resilience helpers — timeout, retry-with-backoff, and a layered fallback chain.
// Together with the circuit breaker (circuit-breaker.js) these implement graceful
// degradation: a call is bounded in time, retried a few times for transient
// faults, and finally degraded through fallback layers instead of hard-failing.

export class TimeoutError extends Error {
  constructor(ms, label) {
    super(`timed out after ${ms}ms${label ? ` (${label})` : ''}`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
  }
}

// Reject if `promise` doesn't settle within `ms`. The underlying work isn't
// cancelled (pass an AbortSignal to the worker if you need that); this just stops
// the caller from waiting forever.
export function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms, label)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry `fn` with exponential backoff + jitter. `shouldRetry(err, attempt)` lets
// callers skip retries for non-transient errors (e.g. 4xx, auth). `sleep` is
// injectable so tests run instantly.
export async function withRetry(fn, { retries = 2, baseDelayMs = 200, factor = 2, jitter = true, shouldRetry = () => true, sleep = defaultSleep, random = Math.random } = {}) {
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
export async function fallbackChain(layers, { onLayerError } = {}) {
  const errors = [];
  for (let i = 0; i < layers.length; i += 1) {
    try {
      return await layers[i](i);
    } catch (err) {
      errors.push(err);
      if (typeof onLayerError === 'function') {
        try { onLayerError(err, i); } catch { /* observer must not break the chain */ }
      }
    }
  }
  const agg = new Error('all fallback layers failed: ' + errors.map((e) => (e && e.message) || String(e)).join(' | '));
  agg.name = 'FallbackExhaustedError';
  agg.code = 'FALLBACK_EXHAUSTED';
  agg.errors = errors;
  throw agg;
}
