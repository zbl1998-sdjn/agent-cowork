import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VizPanel, VizPanelErrorState } from './VizPanel';

describe('VizPanel state views', () => {
  it('renders without an error state by default', () => {
    const html = renderToStaticMarkup(<VizPanel trustedRoot="C:/work" />);

    expect(html).toContain('可视化 / 活页');
    expect(html).not.toContain('state-view--error');
  });

  it('renders viz failures with the reusable error state', () => {
    const html = renderToStaticMarkup(<VizPanelErrorState error="JSON 解析失败" />);

    expect(html).toContain('活页渲染失败');
    expect(html).toContain('JSON 解析失败');
    expect(html).toContain('state-view--error');
    expect(html).toContain('role="alert"');
  });
});
