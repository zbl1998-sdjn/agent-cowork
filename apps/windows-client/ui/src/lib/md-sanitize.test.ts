import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './md';

describe('markdown link sanitization (XSS hardening)', () => {
  it('a crafted URL cannot inject an attribute into an anchor', () => {
    // 构造带引号的 URL 不能逃逸 href 属性并注入 onclick。
    const html = renderMarkdown('[x](https://a"onclick="alert(1))');
    // 伪造 URL 会被拒绝或保留为文本,最终任何 anchor 都不能带 onclick。
    expect(html).not.toMatch(/<a\b[^>]*onclick/i);
    expect(html).not.toMatch(/<a\b[^>]*"\s*onclick/i);
  });

  it('renders a legitimate http/https link with rel=noopener', () => {
    // 合法 http/https 链接仍要正常渲染,并带 noopener 防止新窗口反控。
    const html = renderMarkdown('[ok](https://example.com/path)');
    expect(html).toContain('href="https://example.com/path"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('does not create anchors for javascript: or data: links', () => {
    // javascript: 与 data: 协议直接禁止生成链接,这是 Markdown XSS 的核心边界。
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toMatch(/<a\b/i);
    expect(renderMarkdown('[y](data:text/html,x)')).not.toMatch(/<a\b/i);
  });

  it('escapes the href value', () => {
    // href 必须始终留在引号内,防止后续参数扩展造成属性逃逸。
    const html = renderMarkdown('[z](https://example.com/?q=1)');
    expect(html).toMatch(/href="[^"]*"/);
  });
});
