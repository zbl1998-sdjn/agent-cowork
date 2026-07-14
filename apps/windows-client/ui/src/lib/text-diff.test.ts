import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './text-diff';

describe('computeLineDiff', () => {
  it('marks unchanged text as all same lines', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('marks every line as added when before is empty (new file)', () => {
    expect(computeLineDiff('', 'a\nb')).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  it('marks every line as removed when after is empty (fully deleted)', () => {
    expect(computeLineDiff('a\nb', '')).toEqual([
      { type: 'remove', text: 'a' },
      { type: 'remove', text: 'b' },
    ]);
  });

  it('finds the minimal edit for a single changed line in the middle', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('returns null when the text is too large to diff line-by-line safely', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join('\n');
    expect(computeLineDiff(before, after)).toBeNull();
  });
});
