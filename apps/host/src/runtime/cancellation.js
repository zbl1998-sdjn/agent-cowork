// @ts-check
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
  constructor() {
    /** @type {Map<string, AbortController>} */
    this._controllers = new Map(); // runId -> AbortController
  }

  /**
   * @param {string} runId
   * @returns {AbortController}
   */
  register(runId) {
    if (!runId) {
      throw new Error('CancellationRegistry.register: runId is required');
    }
    const controller = new AbortController();
    this._controllers.set(runId, controller);
    return controller;
  }

  /**
   * @param {string} runId
   * @returns {AbortSignal | null}
   */
  signal(runId) {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal : null;
  }

  /**
   * @param {string} runId
   * @returns {boolean}
   */
  isCancelled(runId) {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal.aborted : false;
  }

  /**
   * @param {string} runId
   * @param {string} [reason]
   * @returns {boolean}
   */
  cancel(runId, reason = 'cancelled') {
    const controller = this._controllers.get(runId);
    if (!controller) {
      return false;
    }
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
    return true;
  }

  /**
   * @param {string} runId
   * @returns {boolean}
   */
  done(runId) {
    return this._controllers.delete(runId);
  }

  // Abort every active run — used by graceful shutdown to drain in-flight SSE.
  /**
   * @param {string} [reason]
   * @returns {number}
   */
  cancelAll(reason = 'shutdown') {
    let n = 0;
    for (const [, controller] of this._controllers) {
      if (!controller.signal.aborted) { controller.abort(reason); n += 1; }
    }
    return n;
  }

  /** @returns {string[]} */
  pending() {
    return [...this._controllers.keys()];
  }
}

/** @returns {CancellationRegistry} */
export function createCancellationRegistry() {
  return new CancellationRegistry();
}
