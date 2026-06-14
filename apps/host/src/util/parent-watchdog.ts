// 父进程看门狗(host · L0 工具 · util)
// ---------------------------------------------------------------------------
// 职责:作为 sidecar 运行时,轮询父进程(桌面外壳)是否仍存活;父进程消失(被强杀/
//       崩溃/正常退出但未来得及 kill 子进程)时回调 onParentGone,让 host 自行优雅
//       退出——彻底杜绝「关窗后孤儿 host 常驻占 3017」。
// 依赖:无内部依赖(L0)。导出:startParentWatchdog / isPidAlive。

export type ParentWatchdogOptions = {
  parentPid: number;
  intervalMs?: number;
  isAlive?: (pid: number) => boolean;
  onParentGone: () => void;
};

/** 进程存活探测:signal 0 不发信号只验证可达;EPERM 视为存活(无权限但进程在)。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM';
  }
}

/**
 * 启动看门狗;返回 stop 函数。parentPid 非法(≤0/非整数)时为 no-op。
 * onParentGone 至多触发一次;定时器 unref,不阻止进程正常退出。
 */
export function startParentWatchdog({
  parentPid,
  intervalMs = 2000,
  isAlive = isPidAlive,
  onParentGone,
}: ParentWatchdogOptions): () => void {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return () => undefined;
  }
  let fired = false;
  const timer: ReturnType<typeof setInterval> = setInterval(() => {
    if (fired) return;
    if (isAlive(parentPid)) return;
    fired = true;
    clearInterval(timer);
    onParentGone();
  }, Math.max(50, intervalMs));
  // Node 定时器才有 unref;浏览器型 lib 下编译时该属性不存在,运行时按需调用。
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    fired = true;
    clearInterval(timer);
  };
}
