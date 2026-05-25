import { type CSSProperties, type ReactNode, useState } from 'react';
import { computeVirtualWindow } from '../../hooks/useVirtualWindow';

// Generic windowed list (FE-5): renders only the visible slice of `items` so a
// conversation with hundreds of messages stays smooth. Uses fixed itemHeight
// for the windowing math (good enough for chat rows); the heavy lifting lives
// in the pure computeVirtualWindow. Self-contained, inline styling, no deps.

export interface VirtualListProps<T> {
  items: T[];
  /** Estimated/fixed row height in px. */
  itemHeight: number;
  /** Viewport height in px. */
  height: number;
  overscan?: number;
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
}

export function VirtualList<T>({
  items,
  itemHeight,
  height,
  overscan = 3,
  renderItem,
  className,
}: VirtualListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const win = computeVirtualWindow({
    scrollTop,
    viewportHeight: height,
    itemHeight,
    count: items.length,
    overscan,
  });

  const rows: ReactNode[] = [];
  for (let i = win.startIndex; i <= win.endIndex; i += 1) {
    rows.push(
      <div key={i} className="virtual-list__row" style={{ height: itemHeight }}>
        {renderItem(items[i], i)}
      </div>,
    );
  }

  const outer: CSSProperties = { height, overflowY: 'auto', position: 'relative' };
  const inner: CSSProperties = { height: win.totalHeight, position: 'relative' };
  const offset: CSSProperties = { transform: `translateY(${win.offsetTop}px)` };

  return (
    <div
      className={className ? `virtual-list ${className}` : 'virtual-list'}
      style={outer}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="virtual-list__sizer" style={inner}>
        <div className="virtual-list__offset" style={offset}>
          {rows}
        </div>
      </div>
    </div>
  );
}

export default VirtualList;
