import { describe, expect, it } from 'vitest';
import { formatProfileEntry } from './MemoryPanel';

describe('MemoryPanel logic', () => {
  it('formats visible profile entries by type, key, and value', () => {
    expect(formatProfileEntry({
      type: 'term',
      key: 'FE',
      value: '前端体验验收',
      evidence: '用户确认',
    // 面向用户的类型文案从"术语"柔化为"名词解释"。
    })).toBe('名词解释 · FE: 前端体验验收');
  });
});
