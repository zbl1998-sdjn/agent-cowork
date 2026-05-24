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
