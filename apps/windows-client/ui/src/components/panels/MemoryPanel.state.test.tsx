import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { MemoryEntryItem, MemoryPanel, MemoryPanelSaveAction, MemoryPanelStateViews } from './MemoryPanel';

function collectByType(node: ReactNode, type: unknown): ReactElement<Record<string, any>>[] {
  const matches: ReactElement<Record<string, any>>[] = [];
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === type) {
        matches.push(child as ReactElement<Record<string, any>>);
      }
      visit((child.props as { children?: ReactNode }).children);
    });
  };
  visit(node);
  return matches;
}

describe('MemoryPanel state views', () => {
  it('renders the reusable empty state when there are no memories', () => {
    const html = renderToStaticMarkup(<MemoryPanel trustedRoot="C:/work" />);

    expect(html).toContain('暂无本地画像记忆');
    expect(html).toContain('保存术语、项目和偏好后会显示在这里。');
    expect(html).toContain('state-view--empty');
    expect(html).toContain('role="status"');
    expect(html).toContain('ui-btn ui-btn--secondary');
  });

  it('renders the reusable error state with retry affordance', () => {
    const html = renderToStaticMarkup(<MemoryPanelStateViews error="读取失败" onRetry={() => {}} />);

    expect(html).toContain('记忆加载失败');
    expect(html).toContain('读取失败');
    expect(html).toContain('重新加载');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders memory item actions with Button primitives and preserves forget callback', () => {
    const entry = { type: 'term' as const, key: 'FE', value: '前端体验验收', evidence: '用户确认' };
    const onForget = vi.fn();
    const html = renderToStaticMarkup(<MemoryEntryItem entry={entry} busy onForget={onForget} />);
    const buttons = collectByType(MemoryEntryItem({ entry, busy: false, onForget }), Button);

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('disabled=""');
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick();
    expect(onForget).toHaveBeenCalledWith(entry);
  });

  it('keeps save action disabled and callback semantics', () => {
    const onLearn = vi.fn();
    const html = renderToStaticMarkup(<MemoryPanelSaveAction busy disabled onLearn={onLearn} />);
    const buttons = collectByType(MemoryPanelSaveAction({ busy: false, disabled: false, onLearn }), Button);

    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('保存中…');
    expect(html).toContain('disabled=""');
    buttons[0].props.onClick();
    expect(onLearn).toHaveBeenCalledOnce();
  });
});
