// 定时任务共享类型(UI · lib/types):API、hooks 与展示组件共同使用的唯一类型事实源。
export interface ScheduleAttempt {
  attemptId: string;
  startedAt: string;
  finishedAt: string;
  status: 'succeeded' | 'failed';
  runId: string | null;
  error: string | null;
  trigger: 'scheduled';
}

export interface ScheduleItem {
  id: string;
  name: string;
  kind?: string;
  cron?: string | null;
  cronHuman?: string | null;
  fireAt?: string | null;
  nextFireAt?: string | null;
  status?: string;
  runs?: number;
  lastError?: string | null;
  lastRunId?: string | null;
  recipeId?: string | null;
  payload?: { recipeId?: unknown; [key: string]: unknown } | null;
  attempts?: ScheduleAttempt[];
}

export interface ScheduleCreateRequest {
  name: string;
  cron?: string;
  fireAt?: string;
  payload: Record<string, unknown>;
}

export interface ScheduleCreateAttempt {
  request: ScheduleCreateRequest;
  fingerprint: string;
  idempotencyKey: string;
}

export type ScheduleTriggerKind = 'cron' | 'once';

export interface ScheduleDraft {
  name: string;
  recipeId: string;
  kind: ScheduleTriggerKind;
  cron?: string;
  fireAt?: string;
  prompt?: string;
  trustedRoot?: string;
  folderGrantId?: string;
}

export interface ScheduleSkill {
  id: string;
  name: string;
  description?: string;
  kind?: string;
  enabled: boolean;
}

export interface WeeklyReportReminderOptions {
  trustedRoot?: string;
  hour?: number;
  minute?: number;
}
