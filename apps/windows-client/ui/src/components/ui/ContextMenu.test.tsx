import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextMenu } from './ContextMenu';

const items = [
  { label: '重命名', onSelect: () => {} },
  { label: '删除', onSelect: () => {}, danger: true },
];

describe('ContextMenu', () => {
  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(<ContextMenu open={false} x={10} y={20} items={items} />);
    expect(html).toBe('');
  });

  it('renders an accessible menu with item labels when open', () => {
    const html = renderToStaticMarkup(<ContextMenu open x={10} y={20} items={items} onClose={() => {}} />);
    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('重命名');
    expect(html).toContain('删除');
  });

  it('disables an item that is marked disabled', () => {
    const html = renderToStaticMarkup(
      <ContextMenu open x={0} y={0} items={[{ label: '不可用', onSelect: () => {}, disabled: true }]} />,
    );
    expect(html).toContain('不可用');
    expect(html).toContain('disabled');
  });
});
