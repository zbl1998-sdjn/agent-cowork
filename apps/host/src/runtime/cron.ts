//
// Cron 解析(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:零依赖的 5 字段 cron 解析 + 下次触发时间计算 + 人类可读描述,供调度器使用。
// 依赖:无。导出:parseCron / nextFireAt / describeCron。
//
// Minimal 5-field cron parser + next-fire calculator. Zero-dep.
//
// Fields (5): minute hour day-of-month month day-of-week
//   minute       0-59
//   hour         0-23
//   day-of-month 1-31
//   month        1-12
//   day-of-week  0-6 (Sunday=0)
//
// Supported tokens per field:
//   *                  every value
//   N                  literal
//   A-B                range
//   A-B/STEP           range with step
//   */STEP             every STEP starting from min
//   A,B,C              union of any of the above
//
// Not supported (intentional, to keep core tiny): names like 'MON',
// last-day-of-month 'L', '#' nth-weekday, '?'.
//
// Time zone: matches the host process local time. Phase B should swap to
// IANA-aware library if cross-region matters.

type FieldLimit = {
  min: number;
  max: number;
};

export type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domStar: boolean;
  dowStar: boolean;
};

const FIELD_LIMITS: [FieldLimit, FieldLimit, FieldLimit, FieldLimit, FieldLimit] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function parseField(token: string, { min, max }: FieldLimit): Set<number> {
  if (token === '*') {
    return rangeSet(min, max, 1);
  }
  const parts = token.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error('cron: empty field');
  }
  const out = new Set<number>();
  for (const part of parts) {
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) {
      throw new Error(`cron: bad step in '${part}'`);
    }
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron: step must be positive integer in '${part}'`);
    }
    const rangePart = stepSplit[0] ?? '';
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = Number(rangePart);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`cron: non-numeric range in '${part}'`);
    }
    if (start < min || end > max || start > end) {
      throw new Error(`cron: out-of-range value in '${part}' (expected ${min}-${max})`);
    }
    for (let value = start; value <= end; value += step) {
      out.add(value);
    }
  }
  return out;
}

function rangeSet(min: number, max: number, step: number): Set<number> {
  const out = new Set<number>();
  for (let value = min; value <= max; value += step) {
    out.add(value);
  }
  return out;
}

export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string') {
    throw new Error('cron: expression must be a string');
  }
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error('cron: expression must have exactly 5 fields');
  }
  const [minute, hour, dom, month, dow] = tokens as [string, string, string, string, string];
  return {
    minute: parseField(minute, FIELD_LIMITS[0]),
    hour: parseField(hour, FIELD_LIMITS[1]),
    dayOfMonth: parseField(dom, FIELD_LIMITS[2]),
    month: parseField(month, FIELD_LIMITS[3]),
    dayOfWeek: parseField(dow, FIELD_LIMITS[4]),
    domStar: dom.trim() === '*',
    dowStar: dow.trim() === '*',
  };
}

function dateMatches(parsed: ParsedCron, candidate: Date): boolean {
  if (!parsed.minute.has(candidate.getMinutes())) return false;
  if (!parsed.hour.has(candidate.getHours())) return false;
  if (!parsed.month.has(candidate.getMonth() + 1)) return false;
  // Cron 经典语义: 如果 day-of-month 和 day-of-week 都不是 *, 任一匹配即可触发。
  const domMatch = parsed.dayOfMonth.has(candidate.getDate());
  const dowMatch = parsed.dayOfWeek.has(candidate.getDay());
  if (parsed.domStar && parsed.dowStar) {
    return true;
  }
  if (parsed.domStar) return dowMatch;
  if (parsed.dowStar) return domMatch;
  return domMatch || dowMatch;
}

export function nextFireAt(expression: string, fromDate: Date = new Date()): Date {
  const parsed = parseCron(expression);
  // Advance to the next whole minute > fromDate.
  const candidate = new Date(fromDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  // Hard bound: search at most 4 years (covers leap-year cases).
  const limit = new Date(fromDate.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);
  while (candidate <= limit) {
    if (dateMatches(parsed, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`cron: no fire time within 4 years for '${expression}'`);
}

export function describeCron(expression: string): string {
  // Friendly hint, not a translation. Best-effort heuristics for common shapes.
  try {
    parseCron(expression);
  } catch (err) {
    return `invalid: ${err instanceof Error ? err.message : String(err)}`;
  }
  const tokens = expression.trim().split(/\s+/);
  const [minute, hour, dom, month, dow] = tokens as [string, string, string, string, string];
  if (minute === '0' && hour === '9' && dom === '*' && month === '*' && dow === '1') {
    return '每周一上午 9:00';
  }
  if (minute === '0' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    return `每天 ${hour.padStart(2, '0')}:00`;
  }
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `每小时第 ${minute} 分钟`;
  }
  return expression;
}
