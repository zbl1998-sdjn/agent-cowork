// 并发限制(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:限制「同时运行」的 Agent 流数量——全局上限 + 每租户上限。tryAcquire 取到则返回释放句柄,取不到返回 null。
//       与 rate-limit.js(限每秒请求数)互补。状态在进程内,多实例可换共享存储。依赖:无。导出:并发限制器工厂。
/**
 * @typedef {() => void} ReleaseHandle
 * @typedef {{ maxConcurrent?: number, maxPerTenant?: number }} ConcurrencyLimiterOptions
 * @typedef {{
 *   tryAcquire(tenantId?: string): ReleaseHandle | null,
 *   stats(): { active: number, tenants: number, maxConcurrent: number, maxPerTenant: number }
 * }} ConcurrencyLimiter
 */

/**
 * In-process concurrency guard for long-running agent streams.
 *
 * Each active agent stream holds an upstream LLM connection plus working memory,
 * so an unbounded number of concurrent streams can exhaust a host instance. This
 * limiter caps the global active count and a per-tenant count, returning a
 * release handle (or null when over the limit, so the route can reply 429). It is
 * the in-process first line of defense; a multi-instance deployment would back
 * the same contract with a shared store (Redis) — see docs/01-scalability.
 *
 * @param {ConcurrencyLimiterOptions} [options]
 * @returns {ConcurrencyLimiter}
 */
export function createConcurrencyLimiter({ maxConcurrent = 64, maxPerTenant = 8 } = {}) {
  let active = 0;
  /** @type {Map<string, number>} */
  const perTenant = new Map(); // tenantId -> count

  return {
    tryAcquire(tenantId = 'tenant_local') {
      const t = perTenant.get(tenantId) || 0;
      if (active >= maxConcurrent || t >= maxPerTenant) return null;
      active += 1;
      perTenant.set(tenantId, t + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
        const cur = (perTenant.get(tenantId) || 1) - 1;
        if (cur <= 0) perTenant.delete(tenantId);
        else perTenant.set(tenantId, cur);
      };
    },
    stats() { return { active, tenants: perTenant.size, maxConcurrent, maxPerTenant }; },
  };
}
