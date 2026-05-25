import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from './useVirtualWindow';

describe('computeVirtualWindow', () => {
  it('returns an empty window for zero items', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 0 });
    expect(w).toEqual({ startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0, visibleCount: 0 });
  });

  it('windows from the top at scrollTop 0 with overscan', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(9); // ceil(100/20)+1=6, +overscan 3
    expect(w.offsetTop).toBe(0);
    expect(w.totalHeight).toBe(2000);
    expect(w.visibleCount).toBe(10);
  });

  it('windows around the middle and computes the spacer offset', () => {
    const w = computeVirtualWindow({ scrollTop: 400, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.startIndex).toBe(17); // firstVisible 20 - overscan 3
    expect(w.endIndex).toBe(29);
    expect(w.offsetTop).toBe(340); // 17 * 20
  });

  it('clamps scrollTop beyond the end to the last items', () => {
    const w = computeVirtualWindow({ scrollTop: 1000000, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.endIndex).toBe(99);
    expect(w.startIndex).toBe(96);
  });

  it('renders all items when the viewport is taller than the content', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 1000, itemHeight: 20, count: 2 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(1);
    expect(w.visibleCount).toBe(2);
  });

  it('respects overscan 0', () => {
    const w = computeVirtualWindow({ scrollTop: 400, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 0 });
    expect(w.startIndex).toBe(20);
    expect(w.endIndex).toBe(26);
  });

  it('guards against a zero itemHeight (no divide-by-zero)', () => {
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 0, count: 10 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(9);
    expect(Number.isFinite(w.totalHeight)).toBe(true);
  });
});
