// @ts-check

// Provider routing + fallback chain (P3-B).
//
// Pure orchestration over an ordered provider chain: try the primary, fall
// through to the next on failure, and (optionally) deprioritize providers whose
// circuit-breaker is open so a known-down provider is tried last instead of
// first. Decoupled from concrete providers — the caller injects a per-provider
// runner — so this stays pure, layer-clean (L1, no upward imports) and testable.

/**
 * @typedef {(provider: string) => boolean} ProviderCircuitReader
 * @typedef {(provider: string) => void} ProviderAttemptReporter
 * @typedef {(provider: string) => unknown | Promise<unknown>} ProviderRunner
 * @typedef {{ provider: string, error: string }} ProviderAttemptError
 * @typedef {{ provider: string, result: unknown, attempts: number }} ProviderRunResult
 * @typedef {{ chain?: unknown[] | null, isOpen?: ProviderCircuitReader, onAttempt?: ProviderAttemptReporter }} ProviderRouterOptions
 * @typedef {{ order: () => string[], run: (runner: ProviderRunner) => Promise<ProviderRunResult> }} ProviderRouter
 */

/**
 * @param {unknown[] | null | undefined} chain
 * @param {{ isOpen?: ProviderCircuitReader }} [options]
 * @returns {string[]}
 */
export function orderProviderChain(chain, { isOpen } = {}) {
  const list = (Array.isArray(chain) ? chain : []).map(String).filter(Boolean);
  const seen = new Set();
  /** @type {string[]} */
  const unique = [];
  for (const name of list) {
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
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
 * @param {unknown[] | null | undefined} chain
 * @param {ProviderRunner | null | undefined} runner
 * @param {{ isOpen?: ProviderCircuitReader, onAttempt?: ProviderAttemptReporter }} [options]
 * @returns {Promise<ProviderRunResult>}
 */
export async function runWithFallback(chain, runner, { isOpen, onAttempt } = {}) {
  if (typeof runner !== 'function') {
    throw new Error('runWithFallback: runner is required');
  }
  const ordered = orderProviderChain(chain, { isOpen });
  if (ordered.length === 0) {
    throw new Error('provider chain is empty');
  }
  /** @type {ProviderAttemptError[]} */
  const errors = [];
  for (const name of ordered) {
    try {
      if (typeof onAttempt === 'function') {
        onAttempt(name);
      }
      const result = await runner(name);
      return { provider: name, result, attempts: errors.length + 1 };
    } catch (err) {
      errors.push({ provider: name, error: err instanceof Error && err.message ? err.message : String(err) });
    }
  }
  const aggregate = Object.assign(new Error(
    `all providers failed: ${errors.map((e) => `${e.provider}(${e.error})`).join(', ')}`,
  ), { attempts: errors });
  throw aggregate;
}

/**
 * @param {ProviderRouterOptions} [options]
 * @returns {ProviderRouter}
 */
export function createProviderRouter({ chain = [], isOpen, onAttempt } = {}) {
  return {
    order() {
      return orderProviderChain(chain, { isOpen });
    },
    run(runner) {
      return runWithFallback(chain, runner, { isOpen, onAttempt });
    },
  };
}
