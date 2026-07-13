// 缓存命中 + 前缀稳定性遥测(host · L1 领域层 · engine)
// ---------------------------------------------------------------------------
// 职责:进程/会话级聚合每次模型调用返回的缓存命中(Kimi 顶层 cached_tokens;
//      DeepSeek prompt_cache_hit_tokens),算累计命中率;并用稳定前缀(system 提示)
//      的 hash 集合诊断「动态内容漏进前缀、把前缀缓存打穿」——同一逻辑前缀应只出现 1 种 hash,
//      出现多种即 distinctPrefixes>1,说明前缀不稳定、命中被打穿。
//      只算账、不发请求;由工具循环在每次调用后喂 usage 进来。镜像 bot 的 cache-stats。
// 依赖:仅标准库。
// 导出:hashPrefix / recordCacheUsage / getCacheTelemetry / getSafeCacheTelemetry / logCacheTelemetry / resetCacheTelemetry

import { sanitizeTelemetryPayload } from '../security/telemetry-allowlist.js';

/** usage 中与缓存相关的字段(Kimi 与 DeepSeek 两种命名都兼容)。 */
export type CacheUsage = {
  prompt_tokens?: unknown;
  cached_tokens?: unknown;
  prompt_cache_hit_tokens?: unknown;
};

const session = { calls: 0, prompt: 0, cached: 0 };
// 进程内出现过的稳定前缀(system 提示)hash 集合:稳定前缀应≈1 个;多个 = 前缀被动态内容打穿。
const prefixes = new Set<string>();
// 分 cacheKey(= runId/session id)聚合,便于定位是哪一路调用命中低 / 前缀不稳。
const byKey = new Map<string, { calls: number; prompt: number; cached: number; prefixes: Set<string> }>();

/** djb2 字符串 hash(确定性、非加密,够做前缀指纹观测)。 */
export function hashPrefix(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function cachedOf(u: CacheUsage): number {
  return Number(u.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0) || 0;
}

/** 把一次调用的 usage 计入会话聚合(+可选 cacheKey 分路 + prefixHash 前缀指纹);返回本次 {cached,prompt,rate}。 */
export function recordCacheUsage(
  usage: CacheUsage | null | undefined,
  opts: { cacheKey?: string; prefixHash?: string } = {},
): { cached: number; prompt: number; rate: number } {
  const u = usage && typeof usage === 'object' ? usage : {};
  const cached = cachedOf(u);
  const prompt = Number(u.prompt_tokens ?? 0) || 0;
  session.calls += 1;
  session.cached += cached;
  session.prompt += prompt;
  if (opts.prefixHash) prefixes.add(opts.prefixHash);
  if (opts.cacheKey) {
    const k = byKey.get(opts.cacheKey) ?? { calls: 0, prompt: 0, cached: 0, prefixes: new Set<string>() };
    k.calls += 1;
    k.prompt += prompt;
    k.cached += cached;
    if (opts.prefixHash) k.prefixes.add(opts.prefixHash);
    byKey.set(opts.cacheKey, k);
  }
  return { cached, prompt, rate: prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0 };
}

export interface KeyCacheStat {
  key: string;
  calls: number;
  hitRatePct: number;
  distinctPrefixes: number; // 该 key 出现的稳定前缀种数;>1 = 前缀被动态内容打穿
  prefixStable: boolean; //    distinctPrefixes <= 1
}

export type SafeCacheTelemetry = {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  hitRatePct: number;
  distinctPrefixes: number;
  prefixStable: boolean;
  byKey: Array<Omit<KeyCacheStat, 'key'> & { slot: number }>;
};

/** 会话聚合摘要 + 分 key 明细(命中率低→前,最该排查前缀)。 */
export function getCacheTelemetry(): {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  hitRatePct: number;
  distinctPrefixes: number;
  prefixStable: boolean;
  byKey: KeyCacheStat[];
} {
  const rate = session.prompt > 0 ? Math.round((session.cached / session.prompt) * 1000) / 10 : 0;
  return {
    calls: session.calls,
    promptTokens: session.prompt,
    cachedTokens: session.cached,
    hitRatePct: rate,
    distinctPrefixes: prefixes.size,
    prefixStable: prefixes.size <= 1,
    byKey: [...byKey]
      .map(([key, k]) => ({
        key,
        calls: k.calls,
        hitRatePct: k.prompt > 0 ? Math.round((k.cached / k.prompt) * 1000) / 10 : 0,
        distinctPrefixes: k.prefixes.size,
        prefixStable: k.prefixes.size <= 1,
      }))
      .sort((a, b) => a.hitRatePct - b.hitRatePct),
  };
}

/** Safe export surface for telemetry uploads: no raw cache keys, prompts, files, paths, or outputs. */
export function getSafeCacheTelemetry(): SafeCacheTelemetry {
  const raw = getCacheTelemetry();
  const summary = {
    ...raw,
    byKey: raw.byKey.map(({ key: _key, ...item }, index) => ({ slot: index + 1, ...item })),
  };
  return sanitizeTelemetryPayload(summary).payload as SafeCacheTelemetry;
}

/** 收尾时打印一行会话累计缓存命中(无调用则静默)。 */
export function logCacheTelemetry(): void {
  const s = getCacheTelemetry();
  if (s.calls === 0) return;
  const warn = s.prefixStable ? '' : ` · ⚠️前缀不稳定(${s.distinctPrefixes} 种,疑似动态内容打穿缓存)`;
  console.log(
    `[cache] 会话累计 ${s.calls} 次 · 命中 ${s.cachedTokens}/${s.promptTokens} 输入 tok(${s.hitRatePct}%)${warn}`,
  );
}

/** 仅测试/分段基线用:清零会话聚合。 */
export function resetCacheTelemetry(): void {
  session.calls = 0;
  session.prompt = 0;
  session.cached = 0;
  prefixes.clear();
  byKey.clear();
}
