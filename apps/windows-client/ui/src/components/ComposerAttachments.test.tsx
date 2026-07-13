import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { attachmentBatchSummary, ComposerAttachments, formatAttachmentSize } from './ComposerAttachments';
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
    expect(html).toContain('已选 2 个文件');
    expect(html).toContain('attachment-size');
    expect(html).toContain('aria-label="移除附件"');
    expect(html).toContain('report.md');
    expect(html).toContain('chart.png');
  });

  it('keeps remove callbacks indexed', () => {
    const onRemove = vi.fn();
    const attachments = [{ name: 'report.md' }, { name: 'chart.png' }] as File[];
    const buttons = collectByType(ComposerAttachments({ attachments, onRemove }), IconButton);

    expect(buttons).toHaveLength(2);
    buttons[1]!.props.onClick();
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it('formats batch size summaries for multiple uploads', () => {
    expect(formatAttachmentSize(1536)).toBe('1.5 KB');
    expect(attachmentBatchSummary([{ name: 'a.txt', size: 1024 }, { name: 'b.txt', size: 2048 }] as File[])).toBe('已选 2 个文件 · 3.0 KB');
  });

  it('marks uploaded Office files as locked layout templates and keeps the role reversible', () => {
    const onToggleTemplate = vi.fn();
    const attachments = [{ name: 'brand-template.docx', size: 2048 }] as File[];
    const node = ComposerAttachments({
      attachments,
      templateFiles: attachments,
      onRemove: () => {},
      onToggleTemplate,
    });
    const html = renderToStaticMarkup(node);

    expect(html).toContain('模板已锁定');
    expect(html).toContain('aria-label="取消版式模板 brand-template.docx"');
    const toggle = collectByType(node, IconButton).find((button) => button.props.className === 'attachment-template-toggle');
    toggle?.props.onClick();
    expect(onToggleTemplate).toHaveBeenCalledWith(0);
  });
});
