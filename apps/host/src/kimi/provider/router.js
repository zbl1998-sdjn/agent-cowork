// @ts-check

// Provider routing + fallback chain (P3-B).
//
// Pure orchestration over an ordered provider chain: try the primary, fall
// through to the next on failure, and (optionally) deprioritize providers whose
// circuit-breaker is open so a known-down provider is tried last instead of
// first. Decoupled from concrete providers — the caller injects a per-provider
// runner — so this stays pure, layer-clean (L1, no upward imports) and testable.

/**
 * @typedef {string | Record<string, unknown>} ProviderCandidate
 * @typedef {(candidate: ProviderCandidate) => boolean} ProviderCircuitReader
 * @typedef {(candidate: ProviderCandidate) => void} ProviderAttemptReporter
 * @typedef {(candidate: ProviderCandidate) => unknown | Promise<unknown>} ProviderRunner
 * @typedef {(error: unknown, candidate: ProviderCandidate, index: number, chain: ProviderCandidate[]) => boolean} ProviderFallbackPredicate
 * @typedef {(event: { failed: ProviderCandidate, next: ProviderCandidate, error: unknown }) => void} ProviderFallbackReporter
 * @typedef {{ provider: string, error: string }} ProviderAttemptError
 * @typedef {{ provider: ProviderCandidate, result: unknown, attempts: number }} ProviderRunResult
 * @typedef {{ chain?: unknown[] | null, isOpen?: ProviderCircuitReader, onAttempt?: ProviderAttemptReporter, shouldFallback?: ProviderFallbackPredicate, onFallback?: ProviderFallbackReporter }} ProviderRouterOptions
 * @typedef {{ order: () => ProviderCandidate[], run: (runner: ProviderRunner) => Promise<ProviderRunResult> }} ProviderRouter
 */

/**
 * @param {ProviderCandidate} candidate
 * @param {string} field
 */
function providerPart(candidate, field) {
  if (!candidate || typeof candidate !== 'object') return '';
  return String(candidate[field] || '').trim();
}

/**
 * @param {ProviderCandidate} candidate
 * @param {number} index
 */
function providerKey(candidate, index) {
  if (typeof candidate === 'string') return candidate;
  const provider = providerPart(candidate, 'provider').toLowerCase();
  const baseUrl = providerPart(candidate, 'baseUrl').replace(/\/+$/, '');
  const model = providerPart(candidate, 'model');
  return provider || baseUrl || model ? `${provider}|${baseUrl}|${model}` : `candidate:${index}`;
}

/** @param {ProviderCandidate} candidate */
function providerLabel(candidate) {
  if (typeof candidate === 'string') return candidate;
  const provider = providerPart(candidate, 'provider') || 'unknown';
  const baseUrl = providerPart(candidate, 'baseUrl').replace(/\/+$/, '');
  const model = providerPart(candidate, 'model');
  return [provider, baseUrl, model].filter(Boolean).join('|');
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error && err.message ? err.message : String(err);
}

/**
 * @param {unknown[] | null | undefined} chain
 * @param {{ isOpen?: ProviderCircuitReader }} [options]
 * @returns {ProviderCandidate[]}
 */
export function orderProviderChain(chain, { isOpen } = {}) {
  const list = (Array.isArray(chain) ? chain : []).filter(Boolean);
  const seen = new Set();
  /** @type {ProviderCandidate[]} */
  const unique = [];
  for (let index = 0; index < list.length; index += 1) {
    const candidate = /** @type {ProviderCandidate} */ (list[index]);
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
 * @param {unknown[] | null | undefined} chain
 * @param {ProviderRunner | null | undefined} runner
 * @param {{ isOpen?: ProviderCircuitReader, onAttempt?: ProviderAttemptReporter, shouldFallback?: ProviderFallbackPredicate, onFallback?: ProviderFallbackReporter }} [options]
 * @returns {Promise<ProviderRunResult>}
 */
export async function runWithFallback(chain, runner, { isOpen, onAttempt, shouldFallback, onFallback } = {}) {
  if (typeof runner !== 'function') {
    throw new Error('runWithFallback: runner is required');
  }
  const ordered = orderProviderChain(chain, { isOpen });
  if (ordered.length === 0) {
    throw new Error('provider chain is empty');
  }
  /** @type {ProviderAttemptError[]} */
  const errors = [];
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
        onFallback({ failed: candidate, next: ordered[index + 1], error: err });
      }
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
