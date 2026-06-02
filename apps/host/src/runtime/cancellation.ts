//
// 取消登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:让长任务(流式聊天、Agent 运行)可按 runId 被中断——即「停止」按钮。run 在自己 runId 下注册一个
//       AbortController,取消请求即 abort 其 signal,run 观察到后提前停止。条目随结束清理。依赖:无。
// Cancellation registry: lets long-running turns (streaming chat, future
// agent runs) be interrupted by runId — the Claude Cowork "stop" button.
//
// A run registers an AbortController under its runId; a cancel request aborts
// that controller's signal, which the run observes to stop early. Entries are
// removed on done() so the map never grows unbounded.

export class CancellationRegistry {
  readonly _controllers = new Map<string, AbortController>(); // runId -> AbortController

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

  // Abort every active run — used by graceful shutdown to drain in-flight SSE.
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
