// @ts-check
//
// 限流(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:按租户的 HTTP 限流(令牌桶):每租户一个以 ratePerSec 回填、上限 burst 的桶,取不到令牌即拒绝并给
//       Retry-After。允许短时突发(体验好)同时约束持续速率(防洪)。与 concurrency.js(限并发流数)互补。
// 可扩展:状态在进程内,多实例可换共享存储(Redis)。依赖:无。导出:限流器工厂。
//
// Per-tenant HTTP rate limiter (gap #1). concurrency.js caps how many agent
// streams run *at once*; this caps how many requests a tenant may make *per
// second*, which is the missing protection against request floods / abusive
// clients at the HTTP layer.
//
// Algorithm: token bucket. Each tenant gets a bucket that refills at `ratePerSec`
// up to `burst`. A request takes one token; if the bucket is empty the request is
// rejected with a Retry-After hint. Token buckets allow short bursts (good UX)
// while bounding the sustained rate (good protection). State is in-process — a
// multi-instance deployment would back this with a shared store (Redis), same as
// the concurrency limiter (see docs/01-scalability).

/**
 * @typedef {object} RateBucket
 * @property {number} tokens
 * @property {number} last
 *
 * @typedef {object} RateLimitOptions
 * @property {number=} ratePerSec
 * @property {number=} burst
 * @property {() => number=} now
 * @property {number=} maxTenants
 *
 * @typedef {object} RateLimitDecision
 * @property {boolean} allowed
 * @property {number} limit
 * @property {number} remaining
 * @property {number} retryAfterSec
 */

/** @param {RateLimitOptions} options */
export function createRateLimiter({
  ratePerSec = 50,
  burst = 100,
  now = () => Date.now(),
  maxTenants = 50000,
} = {}) {
  /** @type {Map<string, RateBucket>} */
  const buckets = new Map(); // tenantId -> { tokens, last }

  /**
   * @param {RateBucket} bucket
   * @param {number} t
   */
  function refill(bucket, t) {
    const elapsedSec = Math.max(0, (t - bucket.last) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * ratePerSec);
    bucket.last = t;
  }

  // Evict an idle (full) bucket when the map grows too large, so a flood of
  // distinct tenant ids can't grow memory without bound.
  function evictIfNeeded() {
    if (buckets.size <= maxTenants) return;
    for (const [key, b] of buckets) {
      if (b.tokens >= burst) { buckets.delete(key); return; }
    }
    // Fallback: drop the oldest-touched bucket.
    const oldest = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last)[0];
    if (oldest) buckets.delete(oldest[0]);
  }

  /**
   * @param {string} [tenantId]
   * @param {number} [cost]
   * @returns {RateLimitDecision}
   */
  function take(tenantId = 'tenant_local', cost = 1) {
    const t = now();
    let bucket = buckets.get(tenantId);
    if (!bucket) {
      bucket = { tokens: burst, last: t };
      buckets.set(tenantId, bucket);
      evictIfNeeded();
    } else {
      refill(bucket, t);
    }
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return { allowed: true, limit: burst, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
    }
    const deficit = cost - bucket.tokens;
    const retryAfterSec = Math.max(1, Math.ceil(deficit / ratePerSec));
    return { allowed: false, limit: burst, remaining: 0, retryAfterSec };
  }

  return {
    take,
    stats: () => ({ tenants: buckets.size, ratePerSec, burst }),
  };
}
