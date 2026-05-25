import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card } from './Card';

describe('Card', () => {
  it('renders a title and body', () => {
    const html = renderToStaticMarkup(<Card title="连接器">内容</Card>);
    expect(html).toContain('连接器');
    expect(html).toContain('内容');
    expect(html).toContain('ui-card__title');
  });

  it('omits the title region when no title is given', () => {
    const html = renderToStaticMarkup(<Card>只有正文</Card>);
    expect(html).toContain('只有正文');
    expect(html).not.toContain('ui-card__title');
  });
});
