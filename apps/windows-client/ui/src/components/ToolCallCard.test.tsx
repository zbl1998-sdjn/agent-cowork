import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  it('surfaces status, duration, and failure reason without expanding', () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          name: 'Write',
          args: { path: 'a.txt' },
          status: 'failed',
          result: { error: 'Path escaped trusted root' },
          durationMs: 1234,
        }}
      />,
    );

    expect(html).toContain('Write');
    expect(html).toContain('失败');
    expect(html).toContain('1.2s');
    expect(html).toContain('失败原因：Path escaped trusted root');
  });
});
