import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, IconButton, PRIMARY_ACTION_BACKGROUND } from './Button';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace('#', '');
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

describe('Button', () => {
  it('renders children, variant/size classes, and defaults to type=button', () => {
    const html = renderToStaticMarkup(<Button variant="primary" size="sm">保存</Button>);
    expect(html).toContain('保存');
    expect(html).toContain('ui-btn--primary');
    expect(html).toContain('ui-btn--sm');
    expect(html).toContain('type="button"');
  });

  it('passes through the disabled attribute', () => {
    const html = renderToStaticMarkup(<Button disabled>不可点</Button>);
    expect(html).toContain('disabled');
  });

  it('keeps an explicit submit type', () => {
    const html = renderToStaticMarkup(<Button type="submit">提交</Button>);
    expect(html).toContain('type="submit"');
  });

  it('keeps primary button contrast above WCAG AA for normal text', () => {
    expect(contrastRatio('#ffffff', PRIMARY_ACTION_BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('IconButton', () => {
  it('exposes an accessible label', () => {
    const html = renderToStaticMarkup(<IconButton label="关闭面板">×</IconButton>);
    expect(html).toContain('aria-label="关闭面板"');
    expect(html).toContain('×');
  });
});
