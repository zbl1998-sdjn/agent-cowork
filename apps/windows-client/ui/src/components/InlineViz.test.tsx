import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineViz, InlineVizErrorState, InlineVizLoadingState } from './InlineViz';

describe('InlineViz state views', () => {
  it('renders the reusable loading state before inline HTML is ready', () => {
    const html = renderToStaticMarkup(
      <InlineViz spec={{ kind: 'bar', data: { labels: ['A'], values: [1] } }} trustedRoot="C:/work" />,
    );

    expect(html).toContain('渲染图表中');
    expect(html).toContain('state-view--loading');
    expect(html).toContain('aria-busy="true"');
  });

  it('renders inline viz failures with ErrorState', () => {
    const html = renderToStaticMarkup(<InlineVizErrorState error="spec 不合法" />);

    expect(html).toContain('图表渲染失败');
    expect(html).toContain('spec 不合法');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });

  it('renders the loading helper with the shared loading class', () => {
    const html = renderToStaticMarkup(<InlineVizLoadingState />);

    expect(html).toContain('渲染图表中');
    expect(html).toContain('state-view--loading');
  });
});
