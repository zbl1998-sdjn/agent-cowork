import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourcesFooter } from './SourcesFooter';

describe('SourcesFooter', () => {
  it('renders nothing when there are no sources', () => {
    const html = renderToStaticMarkup(<SourcesFooter sources={[]} />);
    expect(html).toBe('');
  });

  it('renders the source toggle through the Button primitive', () => {
    const html = renderToStaticMarkup(
      <SourcesFooter sources={[{ path: 'C:/work/a.md', relativePath: 'a.md', startLine: 2 }]} />,
    );

    expect(html).toContain('class="sources-footer"');
    expect(html).toContain('ui-btn ui-btn--secondary ui-btn--sm sources-toggle');
    expect(html).toContain('来源 (1)');
  });
});
