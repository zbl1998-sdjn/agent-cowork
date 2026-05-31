//
// 后台长任务登记表(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:跟踪长时间运行的任务,使 UI 能显示进度、外壳能在完成时弹通知。纯内存、无外部依赖——真正的系统
//       通知经 onComplete 订阅者接入,从而保持分层干净(L2,无上行依赖)且完全可测。
// 依赖:无。导出:后台任务登记表工厂。
// Background long-task registry (05-B6).
//
// Tracks long-running tasks so the UI can show progress and the shell can fire
// a completion notification when one finishes. Pure, in-memory, no external
// deps — the actual OS notification plugs in via `onComplete` subscribers, so
// this stays layer-clean (L2 runtime, no upward imports) and fully testable.

export type BackgroundTaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type BackgroundTask = {
  id: string;
  title: string;
  kind: string;
  status: BackgroundTaskStatus;
  progress: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  result: unknown;
  error: unknown;
};

export type BackgroundTaskSubscriber = (task: BackgroundTask) => void;
export type BackgroundTaskRegisterInput = { id?: unknown; title?: unknown; kind?: unknown };
export type BackgroundTaskUpdatePatch = { progress?: unknown; title?: unknown; status?: unknown };
export type BackgroundTaskCompleteOptions = { ok?: boolean; result?: unknown; error?: unknown };
export type BackgroundTaskListOptions = { status?: BackgroundTaskStatus };
export type BackgroundTaskStoreOptions = { now?: () => number };

export type BackgroundTaskStore = {
  register(input?: BackgroundTaskRegisterInput): BackgroundTask;
  update(id: string, patch?: BackgroundTaskUpdatePatch): BackgroundTask | null;
  complete(id: string, options?: BackgroundTaskCompleteOptions): BackgroundTask | null;
  cancel(id: string): BackgroundTask | null;
  get(id: string): BackgroundTask | null;
  list(options?: BackgroundTaskListOptions): BackgroundTask[];
  pendingCount(): number;
  remove(id: string): boolean;
  onComplete(cb: BackgroundTaskSubscriber): () => boolean | void;
};

const TERMINAL = new Set<BackgroundTaskStatus>(['done', 'failed', 'cancelled']);
const STATUSES = new Set<BackgroundTaskStatus>(['running', ...TERMINAL]);

export function createBackgroundTasks({
  now = () => Date.now(),
}: BackgroundTaskStoreOptions = {}): BackgroundTaskStore {
  const tasks = new Map<string, BackgroundTask>();
  const completeSubscribers = new Set<BackgroundTaskSubscriber>();

  const snapshot = (task: BackgroundTask): BackgroundTask => ({ ...task });

  function notifyComplete(task: BackgroundTask): void {
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
      const task: BackgroundTask = {
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
      if (typeof patch.status === 'string' && STATUSES.has(patch.status as BackgroundTaskStatus)) {
        task.status = patch.status as BackgroundTaskStatus;
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

    onComplete(cb) {
      if (typeof cb !== 'function') {
        return () => {};
      }
      completeSubscribers.add(cb);
      return () => completeSubscribers.delete(cb);
    },
  };
}
