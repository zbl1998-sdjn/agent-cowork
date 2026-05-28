// Pure helpers: turn raw scheduler fields into one short Chinese phrase a
// non-technical user can read at a glance.
//
// Used by SchedulesPanel. Kept dependency-free (L0) so it's trivially testable
// and reusable from other panels or briefings later.

export type ScheduleStatusLike = string | null | undefined;

export type HumanizableSchedule = {
  cron?: string | null;
  cronHuman?: string | null;
  fireAt?: string | null;
  nextFireAt?: string | null;
  status?: ScheduleStatusLike;
};

const STATUS_MAP: Record<string, string> = {
  pending: '等待中',
  active: '运行中',
  scheduled: '已安排',
  running: '正在跑',
  paused: '已暂停',
  cancelled: '已取消',
  failed: '出错了',
  completed: '已完成',
};

export function humanizeScheduleStatus(status: ScheduleStatusLike): string {
  if (!status) return STATUS_MAP.pending;
  const key = String(status).toLowerCase();
  return STATUS_MAP[key] || String(status);
}

// Minimal cron parser. We only friendly-print the common shapes; anything
// fancier just falls through to the raw expression so power users still see
// the truth instead of a lie.
//
// Supported (5-field "minute hour dom month dow"):
//   "0 9 * * *"        → 每天 09:00
//   "30 14 * * *"      → 每天 14:30
//   "0 9 * * 1"        → 每周一 09:00
//   "0 9 * * 1-5"      → 工作日 09:00
//   "0 9 * * 0,6"      → 周末 09:00
//   "0 9 1 * *"        → 每月 1 号 09:00
//   "*/15 * * * *"     → 每 15 分钟
export function humanizeCron(cron: string): string {
  const raw = cron.trim();
  if (!raw) return '';
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [min, hour, dom, mon, dow] = parts;

  // Every-N-minute shorthand: "*/N * * * *"
  const everyN = /^\*\/(\d+)$/.exec(min);
  if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${everyN[1]} 分钟`;
  }

  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return raw;
  const hh = Number(hour).toString().padStart(2, '0');
  const mm = Number(min).toString().padStart(2, '0');
  const time = `${hh}:${mm}`;

  if (dom === '*' && mon === '*' && dow === '*') return `每天 ${time}`;

  if (dom === '*' && mon === '*') {
    if (dow === '1-5') return `工作日 ${time}`;
    if (dow === '0,6' || dow === '6,0') return `周末 ${time}`;
    const single = /^[0-6]$/.exec(dow);
    if (single) return `每${WEEKDAY[Number(single[0])]} ${time}`;
  }

  if (mon === '*' && dow === '*' && /^\d+$/.test(dom)) {
    return `每月 ${Number(dom)} 号 ${time}`;
  }

  return raw;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Format a fire-at timestamp as "today HH:MM" / "tomorrow HH:MM" /
 * "this Wednesday HH:MM" / fallback "May 30 09:00", using local clock.
 *
 * `now` is injectable so the unit test is deterministic.
 */
export function humanizeFireAt(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const hh = t.getHours().toString().padStart(2, '0');
  const mm = t.getMinutes().toString().padStart(2, '0');
  const time = `${hh}:${mm}`;
  const today = startOfLocalDay(now);
  const tomorrow = new Date(today.getTime() + 86400000);
  if (sameLocalDay(t, now)) return `今天 ${time}`;
  if (sameLocalDay(t, tomorrow)) return `明天 ${time}`;
  const diffDays = Math.floor((startOfLocalDay(t).getTime() - today.getTime()) / 86400000);
  if (diffDays > 1 && diffDays < 7) return `${WEEKDAY[t.getDay()]} ${time}`;
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日 ${time}`;
}

/**
 * One-line summary of WHEN a schedule fires. Prefers explicit `cronHuman` from
 * the backend, then folds cron expression into friendly phrasing, then falls
 * back to one-off fireAt formatting.
 */
export function humanizeScheduleWhen(item: HumanizableSchedule, now: Date = new Date()): string {
  if (item.cronHuman && item.cronHuman.trim()) return item.cronHuman.trim();
  if (item.cron && item.cron.trim()) return humanizeCron(item.cron);
  if (item.fireAt) return `一次性 · ${humanizeFireAt(item.fireAt, now) || item.fireAt}`;
  return '';
}

/**
 * Combine WHEN + next-fire into one row, e.g. "每天 09:00 · 下次 今天 09:00".
 */
export function humanizeScheduleLine(item: HumanizableSchedule, now: Date = new Date()): string {
  const when = humanizeScheduleWhen(item, now);
  const next = humanizeFireAt(item.nextFireAt, now);
  if (when && next) return `${when} · 下次 ${next}`;
  return when || (next ? `下次 ${next}` : '');
}
