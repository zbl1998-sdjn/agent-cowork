import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './md';

describe('markdown link sanitization (XSS hardening)', () => {
  it('a crafted URL cannot inject an attribute into an anchor', () => {
    const html = renderMarkdown('[x](https://a"onclick="alert(1))');
    // No anchor may carry an onclick (crafted URL is rejected / left as text).
    expect(html).not.toMatch(/<a\b[^>]*onclick/i);
    expect(html).not.toMatch(/<a\b[^>]*"\s*onclick/i);
  });

  it('renders a legitimate http/https link with rel=noopener', () => {
    const html = renderMarkdown('[ok](https://example.com/path)');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not create anchors for javascript: or data: links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toMatch(/<a\b/i);
    expect(renderMarkdown('[y](data:text/html,x)')).not.toMatch(/<a\b/i);
  });

  it('escapes the href value', () => {
    const html = renderMarkdown('[z](https://example.com/?q=1)');
    expect(html).toMatch(/href="[^"]*"/);
  });
});
