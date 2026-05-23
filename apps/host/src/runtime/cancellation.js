// Cancellation registry: lets long-running turns (streaming chat, future
// agent runs) be interrupted by runId — the Claude Cowork "stop" button.
//
// A run registers an AbortController under its runId; a cancel request aborts
// that controller's signal, which the run observes to stop early. Entries are
// removed on done() so the map never grows unbounded.

export class CancellationRegistry {
  constructor() {
    this._controllers = new Map(); // runId -> AbortController
  }

  register(runId) {
    if (!runId) {
      throw new Error('CancellationRegistry.register: runId is required');
    }
    const controller = new AbortController();
    this._controllers.set(runId, controller);
    return controller;
  }

  signal(runId) {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal : null;
  }

  isCancelled(runId) {
    const controller = this._controllers.get(runId);
    return controller ? controller.signal.aborted : false;
  }

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

  done(runId) {
    return this._controllers.delete(runId);
  }

  // Abort every active run — used by graceful shutdown to drain in-flight SSE.
  cancelAll(reason = 'shutdown') {
    let n = 0;
    for (const [, controller] of this._controllers) {
      if (!controller.signal.aborted) { controller.abort(reason); n += 1; }
    }
    return n;
  }

  pending() {
    return [...this._controllers.keys()];
  }
}

export function createCancellationRegistry() {
  return new CancellationRegistry();
}
