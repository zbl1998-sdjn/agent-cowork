// 计划任务人话化(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:把调度器原始字段(状态/cron/fireAt/nextFireAt)转成一眼能懂的简短中文短语,供 SchedulesPanel 等展示。
// 纯函数、无依赖(L0),now 可注入便于测试。导出:humanizeScheduleStatus / humanizeCron / humanizeFireAt / humanizeScheduleWhen / humanizeScheduleLine。

export type ScheduleStatusLike = string | null | undefined;

export type HumanizableSchedule = {
  cron?: string | null | undefined;
  cronHuman?: string | null | undefined;
  fireAt?: string | null | undefined;
  nextFireAt?: string | null | undefined;
  status?: ScheduleStatusLike | undefined;
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
  if (!status) return STATUS_MAP.pending || '等待中';
  const key = String(status).toLowerCase();
  return STATUS_MAP[key] || String(status);
}

// 最小 cron 解析器:只把常见形态翻成人话;更复杂的表达式原样返回,避免编出不准确解释。
//
// 支持的 5 字段格式("minute hour dom month dow"):
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
  if (!min || !hour || !dom || !mon || !dow) return raw;

  // 每 N 分钟的简写:"*/N * * * *"。
  const everyN = /^\*\/(\d+)$/.exec(min);
  const everyNMinutes = everyN?.[1];
  if (everyNMinutes && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `每 ${everyNMinutes} 分钟`;
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
    const weekday = single?.[0] ? WEEKDAY[Number(single[0])] : undefined;
    if (weekday) return `每${weekday} ${time}`;
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
 * 用本地时钟把触发时间格式化为"今天 HH:MM"、"明天 HH:MM"、"周三 HH:MM",
 * 更远日期则兜底成"5 月 30 日 09:00"。
 *
 * `now` 可注入,让单测不依赖真实系统时间。
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
 * 生成计划任务"何时触发"的一行摘要:优先使用后端给的 cronHuman,其次把 cron
 * 表达式人话化,最后回退到一次性 fireAt。
 */
export function humanizeScheduleWhen(item: HumanizableSchedule, now: Date = new Date()): string {
  if (item.cronHuman && item.cronHuman.trim()) return item.cronHuman.trim();
  if (item.cron && item.cron.trim()) return humanizeCron(item.cron);
  if (item.fireAt) return `一次性 · ${humanizeFireAt(item.fireAt, now) || item.fireAt}`;
  return '';
}

/**
 * 合并触发规则与下次触发时间,例如"每天 09:00 · 下次 今天 09:00"。
 */
export function humanizeScheduleLine(item: HumanizableSchedule, now: Date = new Date()): string {
  const when = humanizeScheduleWhen(item, now);
  const next = humanizeFireAt(item.nextFireAt, now);
  if (when && next) return `${when} · 下次 ${next}`;
  return when || (next ? `下次 ${next}` : '');
}
