import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppComposerDockStatus } from './AppComposerDock';
import { Button } from './ui/Button';

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

describe('AppComposerDockStatus', () => {
  it('renders stop and selected recipe actions through Button primitives', () => {
    const html = renderToStaticMarkup(
      <AppComposerDockStatus
        selectedRecipe={{ id: 'r1', name: '周报' }}
        streamingId="run-1"
        onClearRecipe={() => {}}
        onStopStreaming={() => {}}
      />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(2);
    expect(html).toContain('stop-btn');
    expect(html).toContain('■ 停止生成');
    expect(html).toContain('模板：周报');
    expect(html).toContain('>清除</button>');
  });

  it('keeps stop and clear callbacks wired', () => {
    const onClearRecipe = vi.fn();
    const onStopStreaming = vi.fn();
    const buttons = collectByType(
      AppComposerDockStatus({
        selectedRecipe: { id: 'r1', name: '周报' },
        streamingId: 'run-1',
        onClearRecipe,
        onStopStreaming,
      }),
      Button,
    );

    expect(buttons).toHaveLength(2);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    expect(onStopStreaming).toHaveBeenCalledOnce();
    expect(onClearRecipe).toHaveBeenCalledOnce();
  });
});
