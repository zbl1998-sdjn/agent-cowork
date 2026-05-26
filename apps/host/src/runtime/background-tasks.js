// @ts-check
// Background long-task registry (05-B6).
//
// Tracks long-running tasks so the UI can show progress and the shell can fire
// a completion notification when one finishes. Pure, in-memory, no external
// deps — the actual OS notification plugs in via `onComplete` subscribers, so
// this stays layer-clean (L2 runtime, no upward imports) and fully testable.

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const STATUSES = new Set(['running', ...TERMINAL]);

/**
 * @typedef {'running' | 'done' | 'failed' | 'cancelled'} BackgroundTaskStatus
 * @typedef {{
 *   id: string,
 *   title: string,
 *   kind: string,
 *   status: BackgroundTaskStatus,
 *   progress: number,
 *   startedAt: number,
 *   updatedAt: number,
 *   completedAt: number | null,
 *   result: unknown,
 *   error: unknown
 * }} BackgroundTask
 * @typedef {(task: BackgroundTask) => void} BackgroundTaskSubscriber
 * @typedef {{ id?: unknown, title?: unknown, kind?: unknown }} BackgroundTaskRegisterInput
 * @typedef {{ progress?: unknown, title?: unknown, status?: unknown }} BackgroundTaskUpdatePatch
 * @typedef {{ ok?: boolean, result?: unknown, error?: unknown }} BackgroundTaskCompleteOptions
 * @typedef {{ status?: BackgroundTaskStatus }} BackgroundTaskListOptions
 * @typedef {{
 *   register(input?: BackgroundTaskRegisterInput): BackgroundTask,
 *   update(id: string, patch?: BackgroundTaskUpdatePatch): BackgroundTask | null,
 *   complete(id: string, options?: BackgroundTaskCompleteOptions): BackgroundTask | null,
 *   cancel(id: string): BackgroundTask | null,
 *   get(id: string): BackgroundTask | null,
 *   list(options?: BackgroundTaskListOptions): BackgroundTask[],
 *   pendingCount(): number,
 *   remove(id: string): boolean,
 *   onComplete(cb: BackgroundTaskSubscriber): () => boolean | void
 * }} BackgroundTaskStore
 */

/**
 * @param {{ now?: () => number }} [options]
 * @returns {BackgroundTaskStore}
 */
export function createBackgroundTasks({ now = () => Date.now() } = {}) {
  /** @type {Map<string, BackgroundTask>} */
  const tasks = new Map();
  /** @type {Set<BackgroundTaskSubscriber>} */
  const completeSubscribers = new Set();

  /**
   * @param {BackgroundTask} task
   * @returns {BackgroundTask}
   */
  const snapshot = (task) => ({ ...task });

  /**
   * @param {BackgroundTask} task
   * @returns {void}
   */
  function notifyComplete(task) {
    const snap = snapshot(task);
    for (const cb of completeSubscribers) {
      // A subscriber error must never break task completion.
      try {
        cb(snap);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    /** @param {BackgroundTaskRegisterInput} [input] */
    register({ id, title = '', kind = 'task' } = {}) {
      if (!id) {
        throw new Error('background task id is required');
      }
      const ts = now();
      /** @type {BackgroundTask} */
      const task = {
        id: String(id),
        title: String(title),
        kind: String(kind),
        status: 'running',
        progress: 0,
        startedAt: ts,
        updatedAt: ts,
        completedAt: null,
        result: null,
        error: null,
      };
      tasks.set(task.id, task);
      return snapshot(task);
    },

    /**
     * @param {string} id
     * @param {BackgroundTaskUpdatePatch} [patch]
     */
    update(id, patch = {}) {
      const task = tasks.get(id);
      if (!task) {
        return null;
      }
      if (typeof patch.progress === 'number') {
        task.progress = Math.min(1, Math.max(0, patch.progress));
      }
      if (typeof patch.title === 'string') {
        task.title = patch.title;
      }
      if (typeof patch.status === 'string' && STATUSES.has(patch.status)) {
        task.status = /** @type {BackgroundTaskStatus} */ (patch.status);
      }
      task.updatedAt = now();
      return snapshot(task);
    },

    /**
     * @param {string} id
     * @param {BackgroundTaskCompleteOptions} [options]
     */
    complete(id, { ok = true, result = null, error = null } = {}) {
      const task = tasks.get(id);
      if (!task) {
        return null;
      }
      task.status = ok ? 'done' : 'failed';
      task.result = ok ? result : null;
      task.error = ok ? null : error || 'failed';
      if (ok) {
        task.progress = 1;
      }
      task.completedAt = now();
      task.updatedAt = task.completedAt;
      notifyComplete(task);
      return snapshot(task);
    },

    /** @param {string} id */
    cancel(id) {
      const task = tasks.get(id);
      if (!task) {
        return null;
      }
      task.status = 'cancelled';
      task.completedAt = now();
      task.updatedAt = task.completedAt;
      return snapshot(task);
    },

    /** @param {string} id */
    get(id) {
      const task = tasks.get(id);
      return task ? snapshot(task) : null;
    },

    /** @param {BackgroundTaskListOptions} [options] */
    list({ status } = {}) {
      const all = [...tasks.values()].map(snapshot);
      return status ? all.filter((task) => task.status === status) : all;
    },

    pendingCount() {
      let n = 0;
      for (const task of tasks.values()) {
        if (task.status === 'running') {
          n += 1;
        }
      }
      return n;
    },

    /** @param {string} id */
    remove(id) {
      return tasks.delete(id);
    },

    /**
     * Subscribe to task completion (done/failed). Returns an unsubscribe fn.
     * @param {BackgroundTaskSubscriber} cb
     */
    onComplete(cb) {
      if (typeof cb !== 'function') {
        return () => {};
      }
      completeSubscribers.add(cb);
      return () => completeSubscribers.delete(cb);
    },
  };
}
