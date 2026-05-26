import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../ui/Button';
import { VizPanel, VizPanelActions, VizPanelErrorState } from './VizPanel';

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

describe('VizPanel state views', () => {
  it('renders without an error state by default', () => {
    const html = renderToStaticMarkup(<VizPanel trustedRoot="C:/work" />);

    expect(html).toContain('可视化 / 活页');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('渲染活页');
    expect(html).not.toContain('state-view--error');
  });

  it('renders viz failures with the reusable error state', () => {
    const html = renderToStaticMarkup(<VizPanelErrorState error="JSON 解析失败" />);

    expect(html).toContain('活页渲染失败');
    expect(html).toContain('JSON 解析失败');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders render/reopen actions with Button primitives', () => {
    const html = renderToStaticMarkup(
      <VizPanelActions busy viewUrl="/api/artifacts/live/viz_1" onRender={() => {}} onReopen={() => {}} />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('disabled=""');
    expect(html).toContain('渲染中');
    expect(html).toContain('重开活页');
  });

  it('keeps render and reopen callbacks wired', () => {
    const onRender = vi.fn();
    const onReopen = vi.fn();
    const buttons = collectByType(
      VizPanelActions({ busy: false, viewUrl: '/api/artifacts/live/viz_1', onRender, onReopen }),
      Button,
    );

    expect(buttons).toHaveLength(2);
    buttons[0].props.onClick();
    buttons[1].props.onClick();

    expect(onRender).toHaveBeenCalledOnce();
    expect(onReopen).toHaveBeenCalledOnce();
  });
});
