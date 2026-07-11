// 任务中心 DTO(UI · lib/types):与 Host `/api/tasks` 展示契约对齐。
export type TaskSummaryStatus = 'done' | 'failed' | 'in_progress' | 'awaiting_approval' | 'cancelled';

export interface TaskSummary {
  id: string;
  status: TaskSummaryStatus;
  activeForm: string;
  prompt?: string | undefined;
  summary?: string | undefined;
  error?: string | undefined;
  mode?: string | undefined;
  type?: string | undefined;
  provider?: string | undefined;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
}
