import { describe, expect, it } from 'vitest';
import { computeVirtualWindow } from './useVirtualWindow';

describe('computeVirtualWindow', () => {
  it('returns an empty window for zero items', () => {
    // 空列表必须返回可渲染的空窗口,不能出现负高度或 NaN。
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 0 });
    expect(w).toEqual({ startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0, visibleCount: 0 });
  });

  it('windows from the top at scrollTop 0 with overscan', () => {
    // 顶部窗口需要包含可视区和 overscan,保证向下滚动时不会马上闪烁。
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(9); // ceil(100/20)+1=6,再加 overscan 3。
    expect(w.offsetTop).toBe(0);
    expect(w.totalHeight).toBe(2000);
    expect(w.visibleCount).toBe(10);
  });

  it('windows around the middle and computes the spacer offset', () => {
    // 中段窗口必须同步计算 spacer 偏移,否则虚拟列表内容会和滚动条位置错位。
    const w = computeVirtualWindow({ scrollTop: 400, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.startIndex).toBe(17); // firstVisible 20 - overscan 3。
    expect(w.endIndex).toBe(29);
    expect(w.offsetTop).toBe(340); // 17 * 20。
  });

  it('clamps scrollTop beyond the end to the last items', () => {
    // 极大 scrollTop 要夹到末尾窗口,不能让索引越界。
    const w = computeVirtualWindow({ scrollTop: 1000000, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 3 });
    expect(w.endIndex).toBe(99);
    expect(w.startIndex).toBe(96);
  });

  it('renders all items when the viewport is taller than the content', () => {
    // 内容比视口短时直接渲染全部项目,避免虚拟化把少量内容错误裁掉。
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 1000, itemHeight: 20, count: 2 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(1);
    expect(w.visibleCount).toBe(2);
  });

  it('respects overscan 0', () => {
    // overscan=0 是合法配置,用于验证纯可视窗口的边界计算。
    const w = computeVirtualWindow({ scrollTop: 400, viewportHeight: 100, itemHeight: 20, count: 100, overscan: 0 });
    expect(w.startIndex).toBe(20);
    expect(w.endIndex).toBe(26);
  });

  it('guards against a zero itemHeight (no divide-by-zero)', () => {
    // itemHeight 为 0 时退回安全窗口,防止除零产生 Infinity/NaN 并污染布局。
    const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 100, itemHeight: 0, count: 10 });
    expect(w.startIndex).toBe(0);
    expect(w.endIndex).toBe(9);
    expect(Number.isFinite(w.totalHeight)).toBe(true);
  });
});
