import { describe, expect, it } from 'vitest';
import { buildScheduleCreateRequest, resolveScheduleCreateAttempt } from './schedules';

describe('buildScheduleCreateRequest', () => {
  it('builds a recurring recipe schedule with a trusted workspace', () => {
    expect(buildScheduleCreateRequest({
      name: '每周会议纪要',
      recipeId: 'meeting-actions',
      kind: 'cron',
      cron: '0 9 * * 1',
      prompt: '整理本周会议材料',
      trustedRoot: 'C:/work',
    })).toEqual({
      name: '每周会议纪要',
      cron: '0 9 * * 1',
      payload: {
        recipeId: 'meeting-actions',
        prompt: '整理本周会议材料',
        trustedRoot: 'C:/work',
      },
    });
  });

  it('rejects missing recipes and invalid one-shot times before sending', () => {
    expect(() => buildScheduleCreateRequest({
      name: '无动作',
      recipeId: '',
      kind: 'cron',
      cron: '0 9 * * 1',
    })).toThrow(/recipe/);
    expect(() => buildScheduleCreateRequest({
      name: '坏时间',
      recipeId: 'meeting-actions',
      kind: 'once',
      fireAt: 'not-a-date',
    })).toThrow(/时间/);
  });
});

describe('resolveScheduleCreateAttempt', () => {
  it('reuses the same idempotency key for an uncertain retry and rotates it when input changes', () => {
    let nextKey = 0;
    const keyFactory = () => `key-${++nextKey}`;
    const request = buildScheduleCreateRequest({
      name: '周报草案',
      recipeId: 'weekly-report',
      kind: 'cron',
      cron: '0 9 * * 1',
    });

    const first = resolveScheduleCreateAttempt(request, null, keyFactory);
    const retry = resolveScheduleCreateAttempt({ ...request, payload: { ...request.payload } }, first, keyFactory);
    const changed = resolveScheduleCreateAttempt({ ...request, name: '月报草案' }, retry, keyFactory);

    expect(retry).toBe(first);
    expect(retry.idempotencyKey).toBe('key-1');
    expect(changed.idempotencyKey).toBe('key-2');
    expect(nextKey).toBe(2);
  });
});
