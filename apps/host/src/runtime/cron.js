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

const FIELD_LIMITS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

function parseField(token, { min, max }) {
  if (token === '*') {
    return rangeSet(min, max, 1);
  }
  const parts = token.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`cron: empty field`);
  }
  const out = new Set();
  for (const part of parts) {
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) {
      throw new Error(`cron: bad step in '${part}'`);
    }
    const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron: step must be positive integer in '${part}'`);
    }
    const rangePart = stepSplit[0];
    let start;
    let end;
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
    for (let v = start; v <= end; v += step) {
      out.add(v);
    }
  }
  return out;
}

function rangeSet(min, max, step) {
  const out = new Set();
  for (let v = min; v <= max; v += step) {
    out.add(v);
  }
  return out;
}

export function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw new Error('cron: expression must be a string');
  }
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error('cron: expression must have exactly 5 fields');
  }
  const [minute, hour, dom, month, dow] = tokens;
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

function dateMatches(parsed, candidate) {
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

export function nextFireAt(expression, fromDate = new Date()) {
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

export function describeCron(expression) {
  // Friendly hint, not a translation. Best-effort heuristics for common shapes.
  try {
    parseCron(expression);
  } catch (err) {
    return `invalid: ${err.message}`;
  }
  const tokens = expression.trim().split(/\s+/);
  const [m, h, dom, mo, dow] = tokens;
  if (m === '0' && h === '9' && dom === '*' && mo === '*' && dow === '1') {
    return '每周一上午 9:00';
  }
  if (m === '0' && h !== '*' && dom === '*' && mo === '*' && dow === '*') {
    return `每天 ${h.padStart(2, '0')}:00`;
  }
  if (h === '*' && dom === '*' && mo === '*' && dow === '*') {
    return `每小时第 ${m} 分钟`;
  }
  return expression;
}
