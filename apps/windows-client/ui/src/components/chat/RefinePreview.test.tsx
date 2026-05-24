import { describe, expect, it } from 'vitest';
import { refinePreviewDisabled, refinePreviewPrompt } from './RefinePreview';
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
});
