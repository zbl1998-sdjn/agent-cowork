import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MessageActions } from './MessageActions';

describe('MessageActions', () => {
  it('renders a continue action only when a terminal run can be continued', () => {
    const html = renderToStaticMarkup(
      <MessageActions onCopy={vi.fn()} onContinue={vi.fn()} onRegenerate={vi.fn()} />,
    );
    const withoutContinue = renderToStaticMarkup(
      <MessageActions onCopy={vi.fn()} onRegenerate={vi.fn()} />,
    );

    expect(html).toContain('复制');
    expect(html).toContain('继续');
    expect(html).toContain('重新生成');
    expect(withoutContinue).not.toContain('继续');
  });
});
