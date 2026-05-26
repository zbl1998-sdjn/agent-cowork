import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CommandPalette } from './CommandPalette';

describe('CommandPalette', () => {
  it('renders command items through the menu item primitive', () => {
    const html = renderToStaticMarkup(
      <CommandPalette
        commands={[{ id: 'settings', label: 'API 设置', hint: 'Ctrl+,', run: () => {} }]}
        onClose={() => {}}
      />,
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('ui-menu-item');
    expect(html).toContain('cmdk-item');
    expect(html).toContain('API 设置');
  });
});
