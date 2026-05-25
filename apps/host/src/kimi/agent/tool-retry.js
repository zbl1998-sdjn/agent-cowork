// @ts-check

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']);
const PERMANENT_CODES = new Set(['EACCES', 'EPERM', 'EINVAL', 'ENOENT']);
const RETRYABLE_RE = /\b(?:timeout|timed out|network|temporar(?:y|ily)|busy|locked|rate limit|connection reset|connection refused|try again)\b/i;
const PERMANENT_RE = /\b(?:permission denied|forbidden|unauthorized|invalid args?|missing required|path escaped|outside trusted root|schema|validation|not found)\b/i;

/**
 * @typedef {{ attempts: number, retried: boolean, errors: string[] }} RetryRunSummary
 * @typedef {{ maxAttempts?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: (delayMs: number) => Promise<void>, shouldRetry?: (error: unknown, attempt: number) => boolean }} RetryPolicyOptions
 */

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'error' in err) return String(/** @type {{ error?: unknown }} */ (err).error || '');
  return String(err || '');
}

/** @param {unknown} err @returns {string} */
function errorCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return '';
  return String(/** @type {{ code?: unknown }} */ (err).code || '').toUpperCase();
}

/** @param {unknown} value @returns {boolean} */
function isToolErrorResult(value) {
  return !!(value && typeof value === 'object' && 'error' in value && /** @type {{ error?: unknown }} */ (value).error);
}

/** @param {unknown} err @returns {boolean} */
export function isRetryableToolError(err) {
  const code = errorCode(err);
  const message = errorMessage(err);
  if (code && PERMANENT_CODES.has(code)) return false;
  if (PERMANENT_RE.test(message)) return false;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return RETRYABLE_RE.test(message);
}

/** @param {number} attempt @param {number} baseDelayMs @param {number} maxDelayMs @returns {number} */
function retryDelay(attempt, baseDelayMs, maxDelayMs) {
  const delay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, delay);
}

export class RetryPolicy {
  /** @param {RetryPolicyOptions} [options] */
  constructor(options = {}) {
    this.maxAttempts = Math.max(1, Math.round(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
    this.baseDelayMs = Math.max(0, Math.round(Number(options.baseDelayMs) || DEFAULT_BASE_DELAY_MS));
    this.maxDelayMs = Math.max(this.baseDelayMs, Math.round(Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS));
    this.sleep = options.sleep || defaultSleep;
    this.shouldRetry = options.shouldRetry || isRetryableToolError;
    /** @type {RetryRunSummary} */
    this.lastRun = { attempts: 0, retried: false, errors: [] };
  }

  /**
   * @template T
   * @param {(ctx: { attempt: number }) => Promise<T> | T} operation
   * @returns {Promise<T>}
   */
  async run(operation) {
    /** @type {RetryRunSummary} */
    const summary = { attempts: 0, retried: false, errors: [] };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      summary.attempts = attempt;
      try {
        const result = await operation({ attempt });
        if (isToolErrorResult(result) && this.shouldRetry(result, attempt) && attempt < this.maxAttempts) {
          summary.retried = true;
          summary.errors.push(errorMessage(result));
          await this.sleep(retryDelay(attempt, this.baseDelayMs, this.maxDelayMs));
          continue;
        }
        this.lastRun = summary;
        return result;
      } catch (err) {
        summary.errors.push(errorMessage(err));
        if (!this.shouldRetry(err, attempt) || attempt >= this.maxAttempts) {
          this.lastRun = summary;
          throw err;
        }
        summary.retried = true;
        await this.sleep(retryDelay(attempt, this.baseDelayMs, this.maxDelayMs));
      }
    }
    this.lastRun = summary;
    throw new Error('retry policy exhausted unexpectedly');
  }
}

/**
 * @param {RetryPolicyOptions} [options]
 * @returns {RetryPolicy}
 */
export function createRetryPolicy(options = {}) {
  return new RetryPolicy(options);
}
