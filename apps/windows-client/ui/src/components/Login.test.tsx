import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Login } from './Login';

describe('Login', () => {
  it('renders auth actions through Button primitives while preserving form semantics', () => {
    const html = renderToStaticMarkup(<Login onAuthed={() => {}} onGuest={vi.fn()} />);

    expect(html.match(/class="ui-btn /g)?.length).toBe(4);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('auth-submit');
    expect(html).toContain('auth-guest');
    expect(html).toContain('跳过，先在本地使用 →');
  });
});
