import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VirtualList } from './VirtualList';

describe('VirtualList', () => {
  const items = Array.from({ length: 1000 }, (_, i) => `行${i}`);

  it('renders only the windowed subset at the top, not far-off rows', () => {
    const html = renderToStaticMarkup(
      <VirtualList
        items={items}
        itemHeight={20}
        height={100}
        renderItem={(it) => <span>{it}</span>}
      />,
    );
    expect(html).toContain('行0');
    expect(html).toContain('行9');
    expect(html).not.toContain('行50');
    expect(html).not.toContain('行999');
  });

  it('sizes the full scrollable height for the whole list', () => {
    const html = renderToStaticMarkup(
      <VirtualList
        items={items}
        itemHeight={20}
        height={100}
        renderItem={(it) => <span>{it}</span>}
      />,
    );
    expect(html).toContain('20000px'); // 1000 items * 20px
  });

  it('renders nothing but the container for an empty list', () => {
    const html = renderToStaticMarkup(
      <VirtualList items={[]} itemHeight={20} height={100} renderItem={(it) => <span>{it}</span>} />,
    );
    expect(html).toContain('virtual-list');
    expect(html).not.toContain('virtual-list__row');
  });
});
