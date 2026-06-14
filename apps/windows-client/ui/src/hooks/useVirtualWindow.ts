// useVirtualWindow(UI · hooks 层)
// ---------------------------------------------------------------------------
// 职责:简单的列表虚拟化——只渲染可视区附近的条目,长会话/长列表也保持流畅。依赖:无。
import { useCallback, useMemo, useState } from 'react';

// 轻量零依赖列表虚拟化(FE-5)。computeVirtualWindow 是纯核心:输入滚动几何,
// 返回应渲染的条目范围和占位偏移;保持纯函数便于脱离 DOM 单测。useVirtualWindow
// 只是跟踪 scrollTop 并派生窗口。

export interface VirtualWindowInput {
  scrollTop: number;
  viewportHeight: number;
  itemHeight: number;
  count: number;
  overscan?: number;
}

export interface VirtualWindow {
  /** 首个需要渲染的条目索引。 */
  startIndex: number;
  /** 最后一个需要渲染的条目索引(含端点);空列表为 -1。 */
  endIndex: number;
  /** 首个渲染条目前方的占位高度(px)。 */
  offsetTop: number;
  /** 完整可滚动高度(px)。 */
  totalHeight: number;
  /** 当前窗口内的条目数量。 */
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
