// 任务展示整形(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把内部运行/任务记录整形成「适合前端展示」的精简视图(状态、标题、模式等),隔离内部结构与 UI 契约。
// 依赖:无(纯整形)。导出:任务展示整形函数。

export type RunSummary = {
  id: string;
  status?: string;
  prompt?: string;
  mode?: string;
  type?: string;
  provider?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
};

export type TaskSummary = RunSummary & {
  status: 'done' | 'failed' | 'in_progress' | 'awaiting_approval' | 'cancelled';
  activeForm: string;
};

export function taskFromRun(run: RunSummary): TaskSummary {
  const status: TaskSummary['status'] = run.status === 'succeeded'
    ? 'done'
    : run.status === 'failed'
      ? 'failed'
      : run.status === 'awaiting_approval'
        ? 'awaiting_approval'
        : run.status === 'cancelled'
          ? 'cancelled'
          : 'in_progress';
  const activeForm = status === 'in_progress'
    ? '任务运行中'
    : status === 'failed'
      ? '需要查看错误'
      : status === 'awaiting_approval'
        ? '等待审批'
        : status === 'cancelled'
          ? '已取消'
          : '已完成';
  const task: TaskSummary = {
    id: run.id,
    status,
    activeForm,
  };
  if (run.prompt !== undefined) task.prompt = run.prompt;
  if (run.mode !== undefined) task.mode = run.mode;
  if (run.type !== undefined) task.type = run.type;
  if (run.provider !== undefined) task.provider = run.provider;
  if (run.startedAt !== undefined) task.startedAt = run.startedAt;
  if (run.finishedAt !== undefined) task.finishedAt = run.finishedAt;
  if (run.durationMs !== undefined) task.durationMs = run.durationMs;
  if (run.summary !== undefined) task.summary = run.summary;
  if (run.error !== undefined) task.error = run.error;
  return task;
}
