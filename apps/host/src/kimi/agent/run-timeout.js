// @ts-check

/**
 * @typedef {{
 *   signal?: AbortSignal | null,
 *   timeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} RunTimeoutOptions
 */

/** @param {unknown} value @returns {number} */
function positiveMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** @param {unknown} err @returns {boolean} */
export function isAbortLikeError(err) {
  if (!err) return false;
  if (err instanceof Error) return err.name === 'AbortError' || /abort|aborted|cancel/i.test(err.message);
  return /abort|aborted|cancel/i.test(String(err));
}

/**
 * @param {RunTimeoutOptions} [options]
 */
export function createRunTimeout(options = {}) {
  const controller = new AbortController();
  const upstream = options.signal || null;
  const timeoutMs = positiveMs(options.timeoutMs);
  const setTimer = options.setTimeoutFn || setTimeout;
  const clearTimer = options.clearTimeoutFn || clearTimeout;
  let timedOut = false;
  let disposed = false;
  let timer = null;
  const abortFromUpstream = () => {
    if (!controller.signal.aborted) controller.abort(upstream && upstream.reason);
  };
  if (upstream) {
    if (upstream.aborted) abortFromUpstream();
    else upstream.addEventListener('abort', abortFromUpstream, { once: true });
  }
  if (timeoutMs > 0) {
    timer = setTimer(() => {
      timedOut = true;
      if (!controller.signal.aborted) controller.abort(new Error(`Run timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    timeoutMs,
    timedOut: () => timedOut,
    aborted: () => controller.signal.aborted,
    stopMessage: () => `本轮已达到运行时间上限(${timeoutMs}ms)，已安全停止继续执行。请缩小任务范围、提高时间上限，或让我继续下一轮。`,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimer(timer);
      if (upstream) upstream.removeEventListener('abort', abortFromUpstream);
    },
  };
}
