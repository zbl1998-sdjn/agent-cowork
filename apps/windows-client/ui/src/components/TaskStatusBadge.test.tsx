import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TaskStatusBadge } from './TaskStatusBadge';

describe('TaskStatusBadge', () => {
  it('shows cancelled runs as a stable warning state', () => {
    const html = renderToStaticMarkup(<TaskStatusBadge status="cancelled" />);

    expect(html).toContain('已取消');
    expect(html).toContain('badge-warn');
  });
});
