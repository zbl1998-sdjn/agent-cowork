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
};

export type TaskSummary = RunSummary & {
  status: 'done' | 'failed' | 'in_progress';
  activeForm: string;
};

export function taskFromRun(run: RunSummary): TaskSummary {
  const status = run.status === 'succeeded' ? 'done' : run.status === 'failed' ? 'failed' : 'in_progress';
  return {
    id: run.id,
    status,
    activeForm: status === 'in_progress' ? '任务运行中' : status === 'failed' ? '需要查看错误' : '已完成',
    prompt: run.prompt,
    mode: run.mode,
    type: run.type,
    provider: run.provider,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    summary: run.summary,
  };
}
