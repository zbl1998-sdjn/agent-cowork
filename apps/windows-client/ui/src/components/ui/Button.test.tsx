import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, IconButton } from './Button';

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
});

describe('IconButton', () => {
  it('exposes an accessible label', () => {
    const html = renderToStaticMarkup(<IconButton label="关闭面板">×</IconButton>);
    expect(html).toContain('aria-label="关闭面板"');
    expect(html).toContain('×');
  });
});
