// 计划任务 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:列出计划任务(cron/定时)并取消指定任务(取消带幂等键)。
// 对应路由:/api/schedules、/api/schedules/:id/cancel。导出:listSchedules、cancelSchedule、ScheduleItem。
import { newIdempotencyKey, getJson, postJson } from './transport';

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
}

export interface ScheduleCreateRequest {
  name: string;
  cron?: string;
  fireAt?: string;
  payload: Record<string, unknown>;
}

export interface WeeklyReportReminderOptions {
  trustedRoot?: string;
  hour?: number;
  minute?: number;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(Number(value));
  return Math.min(max, Math.max(min, integer));
}

export function buildWeeklyReportReminderRequest(options: WeeklyReportReminderOptions = {}): ScheduleCreateRequest {
  const hour = clampInteger(options.hour, 0, 23, 17);
  const minute = clampInteger(options.minute, 0, 59, 0);
  const payload: Record<string, unknown> = {
    recipeId: 'weekly-report-beginner',
    beginnerMode: true,
    prompt: '按我的周报偏好整理本周材料,先生成周报草稿和可复制文本。写文件前等我确认,不要覆盖原文件。',
  };
  if (options.trustedRoot) payload.trustedRoot = options.trustedRoot;

  return {
    name: '每周五周报草稿提醒',
    cron: `${minute} ${hour} * * 5`,
    payload,
  };
}

export async function listSchedules(): Promise<ScheduleItem[]> {
  const res = await getJson<{ schedules: ScheduleItem[] }>('/api/schedules');
  return res.schedules || [];
}

export async function cancelSchedule(id: string): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean; cancelled?: boolean }>(
      `/api/schedules/${encodeURIComponent(id)}/cancel`,
      { idempotencyKey: newIdempotencyKey('sched') },
    );
    return Boolean(res.ok || res.cancelled);
  } catch {
    return false;
  }
}
