import { describe, expect, it } from 'vitest';
import {
  humanizeCron,
  humanizeFireAt,
  humanizeScheduleLine,
  humanizeScheduleStatus,
  humanizeScheduleWhen,
} from './schedule-humanize';

describe('humanizeScheduleStatus', () => {
  it('maps known statuses to Chinese', () => {
    expect(humanizeScheduleStatus('active')).toBe('运行中');
    expect(humanizeScheduleStatus('cancelled')).toBe('已取消');
    expect(humanizeScheduleStatus('paused')).toBe('已暂停');
  });

  it('defaults missing status to 等待中', () => {
    expect(humanizeScheduleStatus(null)).toBe('等待中');
    expect(humanizeScheduleStatus(undefined)).toBe('等待中');
    expect(humanizeScheduleStatus('')).toBe('等待中');
  });

  it('passes through unknown statuses verbatim', () => {
    expect(humanizeScheduleStatus('weird-state')).toBe('weird-state');
  });
});

describe('humanizeCron', () => {
  it('formats every-day expressions', () => {
    expect(humanizeCron('0 9 * * *')).toBe('每天 09:00');
    expect(humanizeCron('30 14 * * *')).toBe('每天 14:30');
  });

  it('formats weekday ranges and single days', () => {
    expect(humanizeCron('0 9 * * 1-5')).toBe('工作日 09:00');
    expect(humanizeCron('0 9 * * 0,6')).toBe('周末 09:00');
    expect(humanizeCron('0 9 * * 3')).toBe('每周三 09:00');
  });

  it('formats monthly expressions', () => {
    expect(humanizeCron('0 9 1 * *')).toBe('每月 1 号 09:00');
  });

  it('formats every-N-minutes shorthand', () => {
    expect(humanizeCron('*/15 * * * *')).toBe('每 15 分钟');
  });

  it('falls back to raw expression for unrecognized patterns', () => {
    expect(humanizeCron('0 9 1,15 * *')).toBe('0 9 1,15 * *');
    expect(humanizeCron('weird')).toBe('weird');
  });
});

describe('humanizeFireAt', () => {
  const now = new Date(2026, 4, 28, 10, 0, 0); // 2026-05-28 (Thursday) 10:00 local

  it('classifies same-day as 今天 HH:MM', () => {
    const iso = new Date(2026, 4, 28, 14, 30, 0).toISOString();
    expect(humanizeFireAt(iso, now)).toBe('今天 14:30');
  });

  it('classifies next-day as 明天 HH:MM', () => {
    const iso = new Date(2026, 4, 29, 9, 0, 0).toISOString();
    expect(humanizeFireAt(iso, now)).toBe('明天 09:00');
  });

  it('classifies within-this-week as weekday HH:MM', () => {
    // 2026-05-31 is Sunday (周日)
    const iso = new Date(2026, 4, 31, 9, 0, 0).toISOString();
    expect(humanizeFireAt(iso, now)).toBe('周日 09:00');
  });

  it('falls back to month + day for further future', () => {
    const iso = new Date(2026, 5, 15, 9, 0, 0).toISOString();
    expect(humanizeFireAt(iso, now)).toBe('6 月 15 日 09:00');
  });

  it('returns empty string for missing / invalid input', () => {
    expect(humanizeFireAt(null, now)).toBe('');
    expect(humanizeFireAt('', now)).toBe('');
    expect(humanizeFireAt('not-a-date', now)).toBe('');
  });
});

describe('humanizeScheduleWhen', () => {
  const now = new Date(2026, 4, 28, 10, 0, 0);

  it('prefers explicit cronHuman from backend', () => {
    expect(humanizeScheduleWhen({ cronHuman: '每天 09:00', cron: '0 9 * * *' }, now))
      .toBe('每天 09:00');
  });

  it('folds raw cron when cronHuman missing', () => {
    expect(humanizeScheduleWhen({ cron: '0 9 * * 1-5' }, now)).toBe('工作日 09:00');
  });

  it('formats one-off fireAt with leading marker', () => {
    const iso = new Date(2026, 4, 29, 9, 0, 0).toISOString();
    expect(humanizeScheduleWhen({ fireAt: iso }, now)).toBe('一次性 · 明天 09:00');
  });
});

describe('humanizeScheduleLine', () => {
  const now = new Date(2026, 4, 28, 10, 0, 0);

  it('combines when + next-fire with separator', () => {
    const nextFireAt = new Date(2026, 4, 28, 14, 0, 0).toISOString();
    expect(humanizeScheduleLine({ cron: '0 14 * * *', nextFireAt }, now))
      .toBe('每天 14:00 · 下次 今天 14:00');
  });

  it('shows next-only when no cron/fireAt', () => {
    const nextFireAt = new Date(2026, 4, 29, 9, 0, 0).toISOString();
    expect(humanizeScheduleLine({ nextFireAt }, now)).toBe('下次 明天 09:00');
  });
});
