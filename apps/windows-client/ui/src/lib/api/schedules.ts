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
