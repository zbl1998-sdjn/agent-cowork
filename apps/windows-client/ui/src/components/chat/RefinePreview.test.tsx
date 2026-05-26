import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RefinePreview, refinePreviewDisabled, refinePreviewPrompt } from './RefinePreview';
import type { PromptRefineResult } from '../../lib/api/prompt';

describe('RefinePreview logic', () => {
  it('resolves apply, edit, and ignore without silently changing intent', () => {
    expect(refinePreviewPrompt('apply', '原始', '优化后', '手动改')).toBe('优化后');
    expect(refinePreviewPrompt('edit', '原始', '优化后', '手动改')).toBe('手动改');
    expect(refinePreviewPrompt('ignore', '原始', '优化后', '手动改')).toBe('原始');
  });

  it('falls back to the refined prompt when edited text is blank', () => {
    expect(refinePreviewPrompt('edit', '原始', '优化后', '  ')).toBe('优化后');
  });

  it('disables adoption only when there is nothing to adopt', () => {
    const base: PromptRefineResult = { refined: 'x', changed: false, intent: 'general', missing: [] };
    expect(refinePreviewDisabled(base)).toBe(true);
    expect(refinePreviewDisabled({ ...base, changed: true })).toBe(false);
    expect(refinePreviewDisabled({ ...base, missing: ['target'] })).toBe(false);
  });

  it('renders action buttons through the Button primitive with stable labels', () => {
    const result: PromptRefineResult = { refined: '优化后', changed: true, intent: 'general', missing: [] };
    const html = renderToStaticMarkup(
      <RefinePreview original="原始" result={result} onResolve={() => {}} />,
    );

    expect(html.match(/class="ui-btn /g)?.length).toBe(3);
    expect(html).toContain('ui-btn--secondary');
    expect(html).toContain('ui-btn--md');
    expect(html).toContain('>采用</button>');
    expect(html).toContain('>编辑后采用</button>');
    expect(html).toContain('>忽略</button>');
  });

  it('keeps missing-state action disabling and dismiss label', () => {
    const result: PromptRefineResult = { refined: '优化后', changed: false, intent: 'general', missing: ['目标'] };
    const html = renderToStaticMarkup(
      <RefinePreview original="原始" result={result} onResolve={() => {}} />,
    );

    expect(html).toContain('>采用</button>');
    expect(html).toContain('>编辑后采用</button>');
    expect(html).toContain('>忽略</button>');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});
