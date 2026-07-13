// 工具调用的重试策略(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:对工具执行做指数退避重试,只重试瞬时类错误(超时/网络/繁忙/限流等),
//      对永久类错误(权限/校验/路径越界/不存在等)立即放弃;兼容"抛异常"与"返回 {error}"两种失败形态。
// 依赖:仅标准库(sleep 可注入便于测试)。
// 导出:isRetryableToolError / RetryPolicy(类)/ createRetryPolicy(工厂)
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 2_000;
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE']);
const PERMANENT_CODES = new Set(['EACCES', 'EPERM', 'EINVAL', 'ENOENT']);
const RETRYABLE_RE = /\b(?:timeout|timed out|network|temporar(?:y|ily)|busy|locked|rate limit|connection reset|connection refused|try again)\b/i;
const PERMANENT_RE = /\b(?:permission denied|forbidden|unauthorized|invalid args?|missing required|path escaped|outside trusted root|schema|validation|not found)\b/i;

export type RetryRunSummary = { attempts: number; retried: boolean; errors: string[] };
export type RetryPolicyOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'error' in err) return String((err as { error?: unknown }).error || '');
  return String(err || '');
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object' || !('code' in err)) return '';
  return String((err as { code?: unknown }).code || '').toUpperCase();
}

function isToolErrorResult(value: unknown): boolean {
  return !!(value && typeof value === 'object' && 'error' in value && (value as { error?: unknown }).error);
}

/** 判断错误是否可重试:永久类错误码/文案直接否决,瞬时类错误码或文案命中则放行。 */
export function isRetryableToolError(err: unknown): boolean {
  const code = errorCode(err);
  const message = errorMessage(err);
  if (code && PERMANENT_CODES.has(code)) return false;
  if (PERMANENT_RE.test(message)) return false;
  if (code && RETRYABLE_CODES.has(code)) return true;
  return RETRYABLE_RE.test(message);
}

function retryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const delay = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, delay);
}

/** 重试策略:按最大尝试次数与指数退避封装一次可重试的操作执行。 */
export class RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly shouldRetry: (error: unknown, attempt: number) => boolean;
  lastRun: RetryRunSummary;

  /** 构造重试策略,设定尝试次数、退避基/上限延迟、sleep 实现与可重试判定。 */
  constructor(options: RetryPolicyOptions = {}) {
    this.maxAttempts = Math.max(1, Math.round(Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
    this.baseDelayMs = Math.max(0, Math.round(Number(options.baseDelayMs) || DEFAULT_BASE_DELAY_MS));
    this.maxDelayMs = Math.max(this.baseDelayMs, Math.round(Number(options.maxDelayMs) || DEFAULT_MAX_DELAY_MS));
    this.sleep = options.sleep || defaultSleep;
    this.shouldRetry = options.shouldRetry || isRetryableToolError;
    this.lastRun = { attempts: 0, retried: false, errors: [] };
  }

  /**
   * 执行操作并按策略重试,把本次尝试摘要(次数/是否重试过/错误)记入 lastRun。
   */
  async run<T>(operation: (ctx: { attempt: number }) => Promise<T> | T): Promise<T> {
    const summary: RetryRunSummary = { attempts: 0, retried: false, errors: [] };
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
 * 工厂:创建一个 RetryPolicy 实例。
 */
export function createRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  return new RetryPolicy(options);
}
