import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('renders a label linked to the input', () => {
    const html = renderToStaticMarkup(<Input label="API Key" id="api-key" />);
    expect(html).toContain('API Key');
    expect(html).toContain('for="api-key"');
    expect(html).toContain('id="api-key"');
  });

  it('shows an error with role=alert and marks the input invalid', () => {
    const html = renderToStaticMarkup(<Input label="名称" error="不能为空" />);
    expect(html).toContain('不能为空');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
  });

  it('omits the error region when there is no error', () => {
    const html = renderToStaticMarkup(<Input label="名称" />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-invalid');
  });
});
