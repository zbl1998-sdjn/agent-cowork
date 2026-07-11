// 计划任务 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:列出/创建计划任务(cron/定时),读取可绑定技能,并取消指定任务(写操作带幂等键)。
// 对应路由:/api/schedules、/api/schedules/:id/cancel、/api/skills。
import { newIdempotencyKey, getJson, postJson } from './transport';
import type {
  ScheduleCreateAttempt,
  ScheduleCreateRequest,
  ScheduleDraft,
  ScheduleItem,
  ScheduleSkill,
  WeeklyReportReminderOptions,
} from '../types/schedules';
export type {
  ScheduleCreateAttempt,
  ScheduleCreateRequest,
  ScheduleDraft,
  ScheduleItem,
  ScheduleSkill,
  ScheduleTriggerKind,
  WeeklyReportReminderOptions,
} from '../types/schedules';

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

export function buildScheduleCreateRequest(draft: ScheduleDraft): ScheduleCreateRequest {
  const name = String(draft.name || '').trim();
  const recipeId = String(draft.recipeId || '').trim();
  if (!name) throw new Error('任务名称不能为空');
  if (!recipeId) throw new Error('必须选择一个已启用的 recipe');

  const payload: Record<string, unknown> = { recipeId };
  const prompt = String(draft.prompt || '').trim();
  const trustedRoot = String(draft.trustedRoot || '').trim();
  const folderGrantId = String(draft.folderGrantId || '').trim();
  if (prompt) payload.prompt = prompt;
  if (trustedRoot) payload.trustedRoot = trustedRoot;
  if (folderGrantId) payload.folderGrantId = folderGrantId;

  if (draft.kind === 'cron') {
    const cron = String(draft.cron || '').trim();
    if (!cron) throw new Error('周期表达式不能为空');
    return { name, cron, payload };
  }
  if (draft.kind === 'once') {
    const timestamp = new Date(String(draft.fireAt || '')).getTime();
    if (!Number.isFinite(timestamp)) throw new Error('一次性触发时间无效');
    return { name, fireAt: new Date(timestamp).toISOString(), payload };
  }
  throw new Error('未知的定时任务触发类型');
}

export function resolveScheduleCreateAttempt(
  request: ScheduleCreateRequest,
  previous: ScheduleCreateAttempt | null,
  keyFactory: () => string = () => newIdempotencyKey('sched-create'),
): ScheduleCreateAttempt {
  const fingerprint = JSON.stringify(request);
  if (previous?.fingerprint === fingerprint) return previous;
  return { request, fingerprint, idempotencyKey: keyFactory() };
}

export async function listSchedules(): Promise<ScheduleItem[]> {
  const res = await getJson<{ schedules: ScheduleItem[] }>('/api/schedules');
  return res.schedules || [];
}

export async function listEnabledScheduleSkills(): Promise<ScheduleSkill[]> {
  const res = await getJson<{ skills: ScheduleSkill[] }>('/api/skills');
  return (res.skills || []).filter((skill) => skill.enabled && (!skill.kind || skill.kind === 'recipe'));
}

export async function createSchedule(
  request: ScheduleCreateRequest,
  idempotencyKey = newIdempotencyKey('sched-create'),
): Promise<ScheduleItem> {
  const res = await postJson<{ schedule?: ScheduleItem }>('/api/schedules', {
    ...request,
    idempotencyKey,
  });
  if (!res.schedule) throw new Error('Host 未返回新建的定时任务');
  return res.schedule;
}

export async function cancelSchedule(id: string): Promise<boolean> {
  const res = await postJson<{ ok?: boolean; cancelled?: boolean }>(
    `/api/schedules/${encodeURIComponent(id)}/cancel`,
    { idempotencyKey: newIdempotencyKey('sched') },
  );
  const cancelled = Boolean(res.ok || res.cancelled);
  if (!cancelled) throw new Error('Host 未确认取消定时任务');
  return true;
}
