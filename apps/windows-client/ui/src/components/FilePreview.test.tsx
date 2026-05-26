import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FilePreview } from './FilePreview';

describe('FilePreview', () => {
  it('renders header actions with UI primitives while loading preview data', () => {
    const html = renderToStaticMarkup(<FilePreview path="C:/work/report.md" trustedRoot="C:/work" onClose={() => {}} />);

    expect(html).toContain('文件预览');
    expect(html).toContain('report.md');
    expect(html).toContain('ui-btn ui-btn--secondary');
    expect(html).toContain('ui-icon-btn modal-close');
    expect(html).toContain('加载预览…');
  });
});
