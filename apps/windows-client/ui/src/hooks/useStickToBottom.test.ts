import { describe, expect, it } from 'vitest';
import { isNearBottom, shouldFlagNewContent } from './useStickToBottom';

describe('useStickToBottom helpers', () => {
  it('treats positions inside the threshold as stuck to bottom', () => {
    expect(isNearBottom({ scrollTop: 452, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollTop: 410, scrollHeight: 1000, clientHeight: 500 }, 48)).toBe(false);
  });

  it('only flags new content when the user is detached from the bottom', () => {
    expect(shouldFlagNewContent(false, 1000, 1050)).toBe(true);
    expect(shouldFlagNewContent(true, 1000, 1050)).toBe(false);
    expect(shouldFlagNewContent(false, 1000, 1000)).toBe(false);
  });
});
