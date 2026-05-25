// @ts-check

const DEFAULT_MAX_REPEATS = 4;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * @typedef {{ name?: string, tool?: string, args?: unknown, arguments?: unknown }} ToolCallLike
 * @typedef {{ shouldBreak: boolean, reason: string, tool: string, fingerprint: string, repeatCount: number, consecutiveFailures: number }} LoopDecision
 */

/** @param {unknown} value @param {WeakSet<object>} seen @returns {unknown} */
function normalizeForFingerprint(value, seen) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalizeForFingerprint(item, seen));
  const record = /** @type {Record<string, unknown>} */ (value);
  return Object.keys(record).sort().reduce((out, key) => {
    out[key] = normalizeForFingerprint(record[key], seen);
    return out;
  }, /** @type {Record<string, unknown>} */ ({}));
}

/** @param {unknown} value @returns {string} */
function stableStringify(value) {
  try {
    return JSON.stringify(normalizeForFingerprint(value, new WeakSet()));
  } catch {
    return String(value);
  }
}

/** @param {ToolCallLike} call @returns {{ tool: string, args: unknown, fingerprint: string }} */
function normalizeCall(call) {
  const tool = String(call?.name || call?.tool || 'unknown');
  const args = call?.args !== undefined ? call.args : call?.arguments;
  return { tool, args, fingerprint: `${tool}:${stableStringify(args || {})}` };
}

/** @param {Partial<LoopDecision>} partial @returns {LoopDecision} */
function decision(partial = {}) {
  return {
    shouldBreak: false,
    reason: '',
    tool: '',
    fingerprint: '',
    repeatCount: 0,
    consecutiveFailures: 0,
    ...partial,
  };
}

export class LoopGuard {
  /**
   * @param {{ maxRepeats?: number, maxConsecutiveFailures?: number }} [options]
   */
  constructor(options = {}) {
    this.maxRepeats = Math.max(1, Math.round(Number(options.maxRepeats) || DEFAULT_MAX_REPEATS));
    this.maxConsecutiveFailures = Math.max(1, Math.round(Number(options.maxConsecutiveFailures) || DEFAULT_MAX_CONSECUTIVE_FAILURES));
    this.repeatCounts = new Map();
    this.failureCounts = new Map();
    this.lastDecision = decision();
  }

  /**
   * @param {ToolCallLike} call
   * @param {boolean | { ok?: boolean }} [okOrResult]
   * @returns {LoopDecision}
   */
  observe(call, okOrResult = true) {
    const { tool, fingerprint } = normalizeCall(call);
    const ok = typeof okOrResult === 'object' ? okOrResult.ok !== false : okOrResult !== false;
    const repeatCount = (this.repeatCounts.get(fingerprint) || 0) + 1;
    this.repeatCounts.set(fingerprint, repeatCount);
    const consecutiveFailures = ok ? 0 : (this.failureCounts.get(fingerprint) || 0) + 1;
    this.failureCounts.set(fingerprint, consecutiveFailures);

    if (consecutiveFailures >= this.maxConsecutiveFailures) {
      this.lastDecision = decision({
        shouldBreak: true,
        reason: `Tool ${tool} failed ${consecutiveFailures} consecutive times with the same arguments; stop retrying this path.`,
        tool,
        fingerprint,
        repeatCount,
        consecutiveFailures,
      });
      return this.lastDecision;
    }
    if (repeatCount >= this.maxRepeats) {
      this.lastDecision = decision({
        shouldBreak: true,
        reason: `Tool ${tool} repeated the same arguments ${repeatCount} times; stop the loop and ask for a new approach.`,
        tool,
        fingerprint,
        repeatCount,
        consecutiveFailures,
      });
      return this.lastDecision;
    }
    this.lastDecision = decision({ tool, fingerprint, repeatCount, consecutiveFailures });
    return this.lastDecision;
  }

  /** @returns {LoopDecision} */
  shouldBreak() {
    return this.lastDecision;
  }
}

/**
 * @param {{ maxRepeats?: number, maxConsecutiveFailures?: number }} [options]
 * @returns {LoopGuard}
 */
export function createLoopGuard(options = {}) {
  return new LoopGuard(options);
}
