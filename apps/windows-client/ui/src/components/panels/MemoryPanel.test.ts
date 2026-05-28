import { describe, expect, it } from 'vitest';
import { formatProfileEntry } from './MemoryPanel';

describe('MemoryPanel logic', () => {
  it('formats visible profile entries by type, key, and value', () => {
    expect(formatProfileEntry({
      type: 'term',
      key: 'FE',
      value: '前端体验验收',
      evidence: '用户确认',
    // The user-facing type label was softened: '术语' → '名词解释'.
    })).toBe('名词解释 · FE: 前端体验验收');
  });
});
