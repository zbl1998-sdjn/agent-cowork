import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreviewCard } from './PreviewCard';
import type { FileOperation } from '../lib/types';

const ops: FileOperation[] = [{ type: 'write', path: '会议行动项.txt' } as FileOperation];

describe('PreviewCard', () => {
  it('shows the AI badge only when aiGenerated is true', () => {
    const withAi = renderToStaticMarkup(<PreviewCard operations={ops} aiGenerated />);
    expect(withAi).toContain('AI 生成');

    const withoutAi = renderToStaticMarkup(<PreviewCard operations={ops} />);
    expect(withoutAi).not.toContain('AI 生成');

    const explicitFalse = renderToStaticMarkup(<PreviewCard operations={ops} aiGenerated={false} />);
    expect(explicitFalse).not.toContain('AI 生成');
  });

  it('renders the operation target path', () => {
    const html = renderToStaticMarkup(<PreviewCard operations={ops} aiGenerated />);
    expect(html).toContain('会议行动项.txt');
  });
});
