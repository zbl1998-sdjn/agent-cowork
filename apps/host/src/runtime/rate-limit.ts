// 限流(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:按租户的 HTTP 限流(令牌桶):每租户一个以 ratePerSec 回填、上限 burst 的桶,取不到令牌即拒绝并给
//       Retry-After。允许短时突发(体验好)同时约束持续速率(防洪)。与 concurrency.js(限并发流数)互补。
// 可扩展:状态在进程内,多实例可换共享存储(Redis)。依赖:无。导出:限流器工厂。

type RateBucket = { tokens: number; last: number };
export type RateLimitOptions = {
  ratePerSec?: number;
  burst?: number;
  now?: () => number;
  maxTenants?: number;
};
export type RateLimitDecision = { allowed: boolean; limit: number; remaining: number; retryAfterSec: number };
export type RateLimiter = {
  take(tenantId?: string, cost?: number): RateLimitDecision;
  stats(): { tenants: number; ratePerSec: number; burst: number };
};

export function createRateLimiter({
  ratePerSec = 50,
  burst = 100,
  now = () => Date.now(),
  maxTenants = 50000,
}: RateLimitOptions = {}): RateLimiter {
  const buckets = new Map<string, RateBucket>(); // tenantId -> { tokens, last }

  function refill(bucket: RateBucket, t: number): void {
    const elapsedSec = Math.max(0, (t - bucket.last) / 1000);
    bucket.tokens = Math.min(burst, bucket.tokens + elapsedSec * ratePerSec);
    bucket.last = t;
  }

  // 租户桶过多时优先淘汰已满的空闲桶,防止大量伪 tenantId 撑爆内存。
  function evictIfNeeded(): void {
    if (buckets.size <= maxTenants) return;
    for (const [key, b] of buckets) {
      if (b.tokens >= burst) { buckets.delete(key); return; }
    }
    // 没有空闲桶时退而求其次淘汰最久未触碰的桶。
    const oldest = [...buckets.entries()].sort((a, b) => a[1].last - b[1].last)[0];
    if (oldest) buckets.delete(oldest[0]);
  }

  /**
   * 尝试消耗令牌并返回允许/拒绝决策;拒绝时带 Retry-After 秒数。
   */
  function take(tenantId = 'tenant_local', cost = 1): RateLimitDecision {
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
