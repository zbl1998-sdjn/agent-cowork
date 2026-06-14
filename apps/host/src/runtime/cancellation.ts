// 取消登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:让长任务(流式聊天、Agent 运行)可按 runId 被中断——即「停止」按钮。run 在自己 runId 下注册一个
//       AbortController,取消请求即 abort 其 signal,run 观察到后提前停止。条目随结束清理。依赖:无。

export class CancellationRegistry {
  readonly _controllers = new Map<string, AbortController>(); // runId 到 AbortController 的唯一映射。

  register(runId: string): AbortController {
    if (!runId) {
      throw new Error('CancellationRegistry.register: runId is required');
    }
    const controller = new AbortController();
    this._controllers.set(runId, controller);
    return controller;
  }

  signal(runId: string): AbortSignal | null {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal : null;
  }

  isCancelled(runId: string): boolean {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal.aborted : false;
  }

  cancel(runId: string, reason = 'cancelled'): boolean {
    const controller = this._controllers.get(runId);
    if (!controller) {
      return false;
    }
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
    return true;
  }

  done(runId: string): boolean {
    return this._controllers.delete(runId);
  }

  // 关闭流程调用此方法中断所有在途 run,让 SSE 等长连接尽快排空。
  cancelAll(reason = 'shutdown'): number {
    let n = 0;
    for (const [, controller] of this._controllers) {
      if (!controller.signal.aborted) { controller.abort(reason); n += 1; }
    }
    return n;
  }

  pending(): string[] {
    return [...this._controllers.keys()];
  }
}

export function createCancellationRegistry(): CancellationRegistry {
  return new CancellationRegistry();
}
