// Background long-task registry (05-B6).
//
// Tracks long-running tasks so the UI can show progress and the shell can fire
// a completion notification when one finishes. Pure, in-memory, no external
// deps — the actual OS notification plugs in via `onComplete` subscribers, so
// this stays layer-clean (L2 runtime, no upward imports) and fully testable.

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const STATUSES = new Set(['running', ...TERMINAL]);

export function createBackgroundTasks({ now = () => Date.now() } = {}) {
  const tasks = new Map();
  const completeSubscribers = new Set();

  const snapshot = (task) => ({ ...task });

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
    register({ id, title = '', kind = 'task' } = {}) {
      if (!id) {
        throw new Error('background task id is required');
      }
      const ts = now();
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
      if (patch.status && STATUSES.has(patch.status)) {
        task.status = patch.status;
      }
      task.updatedAt = now();
      return snapshot(task);
    },

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

    get(id) {
      const task = tasks.get(id);
      return task ? snapshot(task) : null;
    },

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

    remove(id) {
      return tasks.delete(id);
    },

    /** Subscribe to task completion (done/failed). Returns an unsubscribe fn. */
    onComplete(cb) {
      if (typeof cb !== 'function') {
        return () => {};
      }
      completeSubscribers.add(cb);
      return () => completeSubscribers.delete(cb);
    },
  };
}
