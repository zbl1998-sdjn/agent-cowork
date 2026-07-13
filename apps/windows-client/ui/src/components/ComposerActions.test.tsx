import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ComposerSendAction, ComposerToolActions, SEND_BUTTON_BACKGROUND } from './ComposerActions';
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

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace('#', '')
    .match(/.{2}/g)
    ?.map((channel) => parseInt(channel, 16) / 255);

  if (!channels || channels.length !== 3) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const toLinear = (channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const r = toLinear(channels[0]!);
  const g = toLinear(channels[1]!);
  const b = toLinear(channels[2]!);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));

  return (lighter + 0.05) / (darker + 0.05);
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
    expect(html).not.toContain('上传版式模板');
    expect(html).toContain('is-active'); // 语音 listening 高亮
    expect(html).toContain('tool-refining'); // 优化中占位
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
    buttons[0]!.props.onClick();
    buttons[1]!.props.onClick();
    buttons[2]!.props.onClick();
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
    buttons[0]!.props.onClick();
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('keeps the send button contrast above WCAG AA for normal text', () => {
    expect(contrastRatio('#ffffff', SEND_BUTTON_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });
});
