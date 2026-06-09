// VirtualList 虚拟滚动列表(UI · 组件层 · components/ui)
// ---------------------------------------------------------------------------
// 职责:按定高窗口化只渲染可视区条目,支撑数百条消息的长列表流畅滚动;滚动位置驱动可视窗口计算。纯展示+回调。
// 依赖:hooks/useVirtualWindow 的纯函数 computeVirtualWindow。关键 props:items、itemHeight、height、overscan、renderItem。
import { type CSSProperties, type ReactNode, useState } from 'react';
import { computeVirtualWindow } from '../../hooks/useVirtualWindow';

export interface VirtualListProps<T> {
  items: T[];
  /** 估算或固定的行高(px)。 */
  itemHeight: number;
  /** 视口高度(px)。 */
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
    const item = items[i];
    if (item === undefined) continue;
    rows.push(
      <div key={i} className="virtual-list__row" style={{ height: itemHeight }}>
        {renderItem(item, i)}
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
