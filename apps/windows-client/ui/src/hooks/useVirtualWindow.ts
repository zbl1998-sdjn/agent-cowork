import { useCallback, useMemo, useState } from 'react';

// Lightweight, zero-dependency list virtualization (FE-5).
// `computeVirtualWindow` is the pure core: given scroll geometry it returns the
// slice of items to render plus the spacer offsets. Kept pure so the windowing
// math is fully unit-testable without a DOM. `useVirtualWindow` is a thin hook
// that tracks scrollTop and derives the window.

export interface VirtualWindowInput {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  count: number;
  overscan?: number;
}

export interface VirtualWindow {
  /** First item index to render. */
  startIndex: number;
  /** Last item index to render (inclusive); -1 when empty. */
  endIndex: number;
  /** Spacer height (px) before the first rendered item. */
  offsetTop: number;
  /** Full scrollable height (px). */
  totalHeight: number;
  /** Number of items in the window. */
  visibleCount: number;
}

export function computeVirtualWindow({
  scrollTop,
  viewportHeight,
  itemHeight,
  count,
  overscan = 3,
}: VirtualWindowInput): VirtualWindow {
  const safeItem = Math.max(1, itemHeight);
  const safeCount = Math.max(0, Math.floor(count));
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const totalHeight = safeCount * safeItem;

  if (safeCount === 0) {
    return { startIndex: 0, endIndex: -1, offsetTop: 0, totalHeight: 0, visibleCount: 0 };
  }

  const maxScroll = Math.max(0, totalHeight - 1);
  const safeScroll = Math.min(Math.max(0, scrollTop), maxScroll);
  const firstVisible = Math.floor(safeScroll / safeItem);
  const visibleSpan = Math.ceil(Math.max(0, viewportHeight) / safeItem) + 1;

  const startIndex = Math.max(0, firstVisible - safeOverscan);
  const endIndex = Math.min(safeCount - 1, firstVisible + visibleSpan + safeOverscan);

  return {
    startIndex,
    endIndex,
    offsetTop: startIndex * safeItem,
    totalHeight,
    visibleCount: endIndex - startIndex + 1,
  };
}

export interface ScrollLike {
  currentTarget: { scrollTop: number };
}

export function useVirtualWindow(
  count: number,
  itemHeight: number,
  viewportHeight: number,
  overscan = 3,
) {
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback((event: ScrollLike) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const window = useMemo(
    () => computeVirtualWindow({ scrollTop, viewportHeight, itemHeight, count, overscan }),
    [scrollTop, viewportHeight, itemHeight, count, overscan],
  );

  return { ...window, scrollTop, onScroll, setScrollTop };
}
