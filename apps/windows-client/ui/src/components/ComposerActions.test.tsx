import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerSendAction, ComposerToolActions } from './ComposerActions';
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

describe('ComposerActions', () => {
  it('renders upload, voice, and refine tools through Button primitives', () => {
    const html = renderToStaticMarkup(
      <ComposerToolActions
        listening
        refining
        canRefine
        onUpload={() => {}}
        onToggleVoice={() => {}}
        onRefine={() => {}}
      />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(3);
    expect(html).toContain('tool-button is-active');
    expect(html).toContain('优化中…');
    expect(html).toContain('disabled=""');
  });

  it('keeps tool callbacks wired', () => {
    const onUpload = vi.fn();
    const onToggleVoice = vi.fn();
    const onRefine = vi.fn();
    const buttons = collectByType(
      ComposerToolActions({
        listening: false,
        refining: false,
        canRefine: true,
        onUpload,
        onToggleVoice,
        onRefine,
      }),
      Button,
    );

    expect(buttons).toHaveLength(3);
    buttons[0].props.onClick();
    buttons[1].props.onClick();
    buttons[2].props.onClick();
    expect(onUpload).toHaveBeenCalledOnce();
    expect(onToggleVoice).toHaveBeenCalledOnce();
    expect(onRefine).toHaveBeenCalledOnce();
  });

  it('renders send as a primary Button and preserves disabled state', () => {
    const onSend = vi.fn();
    const html = renderToStaticMarkup(<ComposerSendAction refining onSend={onSend} />);
    const buttons = collectByType(ComposerSendAction({ refining: false, onSend }), Button);

    expect(html).toContain('ui-btn ui-btn--primary');
    expect(html).toContain('send-button');
    expect(html).toContain('disabled=""');
    buttons[0].props.onClick();
    expect(onSend).toHaveBeenCalledOnce();
  });
});
