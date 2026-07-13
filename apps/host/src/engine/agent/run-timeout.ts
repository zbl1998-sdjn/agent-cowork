// 单次运行的超时与中止控制(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:派生一个 AbortController,把上游 signal 与本地超时定时器合并成一个统一信号;
//      到点自动 abort 并标记 timedOut,提供中文停止文案与 dispose 清理。
// 依赖:仅标准库(AbortController / setTimeout,定时器可注入便于测试)。
// 导出:isAbortLikeError(判断错误是否由中止引发)/ createRunTimeout
export type RunTimeoutOptions = {
  signal?: AbortSignal | null;
  timeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
};
export type RunTimeoutHandle = {
  signal: AbortSignal;
  timeoutMs: number;
  timedOut(): boolean;
  aborted(): boolean;
  stopMessage(): string;
  dispose(): void;
};

function positiveMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** 判断错误是否属于"中止/取消"类(AbortError 或消息含 abort/cancel)。 */
export function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) return err.name === 'AbortError' || /abort|aborted|cancel/i.test(err.message);
  return /abort|aborted|cancel/i.test(String(err));
}

/**
 * 创建运行超时控制器:合并上游中止信号与本地超时,返回统一 signal 及状态查询/清理方法。
 */
export function createRunTimeout(options: RunTimeoutOptions = {}): RunTimeoutHandle {
  const controller = new AbortController();
  const upstream = options.signal || null;
  const timeoutMs = positiveMs(options.timeoutMs);
  const setTimer = options.setTimeoutFn || setTimeout;
  const clearTimer = options.clearTimeoutFn || clearTimeout;
  let timedOut = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortFromUpstream = () => {
    if (!controller.signal.aborted) controller.abort(upstream?.reason);
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
