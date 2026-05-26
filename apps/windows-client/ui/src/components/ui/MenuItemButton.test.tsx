import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ListboxOptionButton, MenuItemButton } from './MenuItemButton';

describe('MenuItemButton', () => {
  it('renders menuitem semantics and primitive class', () => {
    const html = renderToStaticMarkup(<MenuItemButton className="cmdk-item">设置</MenuItemButton>);

    expect(html).toContain('role="menuitem"');
    expect(html).toContain('ui-menu-item');
    expect(html).toContain('cmdk-item');
    expect(html).toContain('type="button"');
  });

  it('renders active listbox options with aria-selected', () => {
    const html = renderToStaticMarkup(<ListboxOptionButton active className="popover-item">文件</ListboxOptionButton>);

    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('is-active');
    expect(html).toContain('popover-item');
  });
});
