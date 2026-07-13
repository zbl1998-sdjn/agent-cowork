import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VizPanel } from './VizPanel';

describe('VizPanel', () => {
  it('uses the advanced Office and web editor as the primary visualization surface', () => {
    const html = renderToStaticMarkup(<VizPanel trustedRoot="C:/work" />);

    expect(html).toContain('可视化编辑');
    expect(html).toContain('Word、Excel、PPT 和网页');
    expect(html).toContain('模板锁定');
    expect(html).not.toContain('手动 JSON 活页');
  });
});
