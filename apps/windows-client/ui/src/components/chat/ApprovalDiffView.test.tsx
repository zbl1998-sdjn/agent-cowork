import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalDiffView, isDiffPreview } from './ApprovalDiffView';

describe('isDiffPreview', () => {
  it('recognizes a text diff preview shape', () => {
    expect(isDiffPreview({ kind: 'text', path: 'a.txt', before: null, after: 'x' })).toBe(true);
  });

  it('recognizes a binary diff preview shape', () => {
    expect(isDiffPreview({ kind: 'binary', path: 'a.png', beforeBytes: null, afterBytes: 3 })).toBe(true);
  });

  it('rejects unrelated preview shapes (e.g. ScheduleTask JSON fields)', () => {
    expect(isDiffPreview({ name: 'daily digest', cron: '0 9 * * *' })).toBe(false);
    expect(isDiffPreview(null)).toBe(false);
    expect(isDiffPreview('a string')).toBe(false);
  });
});

describe('ApprovalDiffView', () => {
  it('renders a line-by-line diff with +/- markers for a text change', () => {
    const html = renderToStaticMarkup(
      <ApprovalDiffView preview={{ kind: 'text', path: 'a.txt', before: 'hello\nworld', after: 'hello\nthere' }} />,
    );
    expect(html).toContain('a.txt');
    expect(html).toContain('is-remove');
    expect(html).toContain('is-add');
    expect(html).toContain('world');
    expect(html).toContain('there');
  });

  it('labels a null before side as a new file', () => {
    const html = renderToStaticMarkup(
      <ApprovalDiffView preview={{ kind: 'text', path: 'new.txt', before: null, after: 'fresh' }} />,
    );
    expect(html).toContain('新建文件');
  });

  it('renders a byte-count summary instead of content for binary previews', () => {
    const html = renderToStaticMarkup(
      <ApprovalDiffView preview={{ kind: 'binary', path: 'img.png', beforeBytes: 10, afterBytes: 20 }} />,
    );
    expect(html).toContain('img.png');
    expect(html).toContain('10');
    expect(html).toContain('20');
  });

  it('falls back to a whole-block before/after view when the diff is too large to compute', () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join('\n');
    const html = renderToStaticMarkup(<ApprovalDiffView preview={{ kind: 'text', path: 'big.txt', before, after }} />);
    expect(html).toContain('改动过大');
    expect(html).toContain('line 0');
    expect(html).toContain('changed 0');
  });
});
