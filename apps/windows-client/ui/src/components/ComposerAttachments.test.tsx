import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerAttachments } from './ComposerAttachments';
import { IconButton } from './ui/Button';

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

describe('ComposerAttachments', () => {
  it('renders remove actions through IconButton primitives', () => {
    const attachments = [{ name: 'report.md' }, { name: 'chart.png' }] as File[];
    const html = renderToStaticMarkup(<ComposerAttachments attachments={attachments} onRemove={() => {}} />);

    expect(html.match(/class="ui-icon-btn/g)?.length).toBe(2);
    expect(html).toContain('attachment-remove');
    expect(html).toContain('aria-label="移除附件"');
    expect(html).toContain('report.md');
    expect(html).toContain('chart.png');
  });

  it('keeps remove callbacks indexed', () => {
    const onRemove = vi.fn();
    const attachments = [{ name: 'report.md' }, { name: 'chart.png' }] as File[];
    const buttons = collectByType(ComposerAttachments({ attachments, onRemove }), IconButton);

    expect(buttons).toHaveLength(2);
    buttons[1].props.onClick();
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
