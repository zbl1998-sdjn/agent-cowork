// 提供商路由与回退链(host · L1 领域层 · kimi/provider)
// ---------------------------------------------------------------------------
// 职责:对一条有序提供商链做纯编排——去重、按熔断状态重排(开路者降级到末位
//       而非丢弃)、依次尝试并在失败时回退,全部失败则聚合错误抛出。
// 角色:与注册表 index 配套的「路由」层——index 解析「用哪家」,router 决定
//       「按什么顺序尝试、何时回退」;具体提供商由调用方注入 runner,保持纯函数。
// 依赖:仅标准库(不向上引用,layer-clean)。
// 导出:orderProviderChain、runWithFallback、createProviderRouter。

// Provider routing + fallback chain (P3-B).
//
// Pure orchestration over an ordered provider chain: try the primary, fall
// through to the next on failure, and (optionally) deprioritize providers whose
// circuit-breaker is open so a known-down provider is tried last instead of
// first. Decoupled from concrete providers — the caller injects a per-provider
// runner — so this stays pure, layer-clean (L1, no upward imports) and testable.

export type ProviderCandidate = string | Record<string, unknown>;
type ProviderCircuitReader = (candidate: ProviderCandidate) => boolean;
type ProviderAttemptReporter = (candidate: ProviderCandidate) => void;
export type ProviderRunner = (candidate: ProviderCandidate) => unknown | Promise<unknown>;
type ProviderFallbackPredicate = (error: unknown, candidate: ProviderCandidate, index: number, chain: ProviderCandidate[]) => boolean;
type ProviderFallbackReporter = (event: { failed: ProviderCandidate; next: ProviderCandidate; error: unknown }) => void;
type ProviderAttemptError = { provider: string; error: string };
export type ProviderRunResult = { provider: ProviderCandidate; result: unknown; attempts: number };
type ProviderRouterOptions = {
  chain?: unknown[] | null;
  isOpen?: ProviderCircuitReader;
  onAttempt?: ProviderAttemptReporter;
  shouldFallback?: ProviderFallbackPredicate;
  onFallback?: ProviderFallbackReporter;
};
type ProviderRouter = { order: () => ProviderCandidate[]; run: (runner: ProviderRunner) => Promise<ProviderRunResult> };

function providerPart(candidate: ProviderCandidate, field: string): string {
  if (!candidate || typeof candidate !== 'object') return '';
  return String(candidate[field] || '').trim();
}

function providerKey(candidate: ProviderCandidate, index: number): string {
  if (typeof candidate === 'string') return candidate;
  const provider = providerPart(candidate, 'provider').toLowerCase();
  const baseUrl = providerPart(candidate, 'baseUrl').replace(/\/+$/, '');
  const model = providerPart(candidate, 'model');
  return provider || baseUrl || model ? `${provider}|${baseUrl}|${model}` : `candidate:${index}`;
}

function providerLabel(candidate: ProviderCandidate): string {
  if (typeof candidate === 'string') return candidate;
  const provider = providerPart(candidate, 'provider') || 'unknown';
  const baseUrl = providerPart(candidate, 'baseUrl').replace(/\/+$/, '');
  const model = providerPart(candidate, 'model');
  return [provider, baseUrl, model].filter(Boolean).join('|');
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

/**
 * 对提供商链去重并排序:熔断闭合者保持原序在前,开路者降级到末位仍保留为兜底。
 */
export function orderProviderChain(chain: unknown[] | null | undefined, { isOpen }: { isOpen?: ProviderCircuitReader } = {}): ProviderCandidate[] {
  const list = (Array.isArray(chain) ? chain : []).filter(Boolean);
  const seen = new Set<string>();
  const unique: ProviderCandidate[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const candidate = list[index] as ProviderCandidate;
    const key = providerKey(candidate, index);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }
  if (typeof isOpen !== 'function') {
    return unique;
  }
  // Circuit-closed providers first (original order); open ones last, still
  // attempted as a last resort rather than dropped.
  const available = unique.filter((name) => !isOpen(name));
  const downed = unique.filter((name) => isOpen(name));
  return [...available, ...downed];
}

/**
 * 沿排序后的链依次用 runner 尝试,失败按 shouldFallback 决定是否回退,全失败则聚合抛出。
 */
export async function runWithFallback(
  chain: unknown[] | null | undefined,
  runner: ProviderRunner | null | undefined,
  { isOpen, onAttempt, shouldFallback, onFallback }: Omit<ProviderRouterOptions, 'chain'> = {},
): Promise<ProviderRunResult> {
  if (typeof runner !== 'function') {
    throw new Error('runWithFallback: runner is required');
  }
  const ordered = orderProviderChain(chain, { isOpen });
  if (ordered.length === 0) {
    throw new Error('provider chain is empty');
  }
  const errors: ProviderAttemptError[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index];
    try {
      if (typeof onAttempt === 'function') {
        onAttempt(candidate);
      }
      const result = await runner(candidate);
      return { provider: candidate, result, attempts: errors.length + 1 };
    } catch (err) {
      errors.push({ provider: providerLabel(candidate), error: errorMessage(err) });
      const hasNext = index < ordered.length - 1;
      const canFallback = hasNext && (typeof shouldFallback !== 'function' || shouldFallback(err, candidate, index, ordered));
      if (!canFallback) {
        if (hasNext && typeof shouldFallback === 'function') throw err;
        break;
      }
      if (typeof onFallback === 'function') {
        onFallback({ failed: candidate, next: ordered[index + 1] as ProviderCandidate, error: err });
      }
    }
  }
  const aggregate = Object.assign(new Error(
    `all providers failed: ${errors.map((e) => `${e.provider}(${e.error})`).join(', ')}`,
  ), { attempts: errors });
  throw aggregate;
}

/**
 * 创建绑定好链与熔断读取器的路由器(暴露 order/run,封装上面两个纯函数)。
 */
export function createProviderRouter({ chain = [], isOpen, onAttempt }: ProviderRouterOptions = {}): ProviderRouter {
  return {
    order() {
      return orderProviderChain(chain, { isOpen });
    },
    run(runner) {
      return runWithFallback(chain, runner, { isOpen, onAttempt });
    },
  };
}
