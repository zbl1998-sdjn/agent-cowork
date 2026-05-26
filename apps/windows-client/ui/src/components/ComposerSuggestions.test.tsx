import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerSuggestions } from './ComposerSuggestions';

describe('ComposerSuggestions', () => {
  it('renders listbox options through the shared option primitive', () => {
    const html = renderToStaticMarkup(
      <ComposerSuggestions
        mode="template"
        active={1}
        items={[
          { key: 'cmd:new', title: '新建对话', detail: '命令', apply: vi.fn() },
          { key: 'recipe:weekly', title: '周报', detail: '模板', apply: vi.fn() },
        ]}
      />,
    );

    expect(html).toContain('role="listbox"');
    expect(html).toContain('命令 / 任务模板');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('ui-menu-item is-active popover-item');
    expect(html).toContain('周报');
  });
});
