import { describe, expect, it, vi } from 'vitest';
import {
  buildHistorySuggestionItems,
  buildMentionSuggestionItems,
  buildTemplateSuggestionItems,
  findComposerTrigger,
  mentionInsertText,
} from './composer-trigger';

describe('findComposerTrigger', () => {
  it('detects slash, history, and file mention triggers before the caret', () => {
    expect(findComposerTrigger('/sum')).toEqual({ mode: 'template', query: 'sum', triggerStart: 0 });
    expect(findComposerTrigger('before\n#run')).toEqual({ mode: 'history', query: 'run', triggerStart: 7 });
    expect(findComposerTrigger('open @readme')).toEqual({ mode: 'mention', query: 'readme', triggerStart: 5 });
  });

  it('ignores non-terminal trigger text', () => {
    expect(findComposerTrigger('/summary done')).toBeNull();
    expect(findComposerTrigger('email/a')).toBeNull();
  });
});

describe('composer suggestion builders', () => {
  it('puts matching commands before matching recipes', () => {
    const onCommand = vi.fn();
    const onRecipe = vi.fn();
    const items = buildTemplateSuggestionItems({
      slashCommands: [{ id: 'new-chat', label: '新对话', run: vi.fn() }],
      recipes: [{ id: 'summary-report', name: '总结报告', summary: '汇总材料' }],
      query: '',
      onCommand,
      onRecipe,
    });

    expect(items.map((item) => item.key)).toEqual(['cmd:new-chat', 'summary-report']);
    items[0].apply();
    items[1].apply();
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-chat' }));
    expect(onRecipe).toHaveBeenCalledWith(expect.objectContaining({ id: 'summary-report' }));
  });

  it('builds history and mention items with stable labels', () => {
    const onHistory = vi.fn();
    const history = buildHistorySuggestionItems({
      historyRuns: [{ id: 'run_1', promptPreview: '整理 README' }],
      query: 'readme',
      onPick: onHistory,
    });
    expect(history[0]).toMatchObject({ key: 'run_1', title: '整理 README', detail: 'run_1' });

    const onMention = vi.fn();
    const mention = buildMentionSuggestionItems(
      [{ path: 'C:/repo/README.md', relativePath: 'docs/README.md' }],
      onMention,
    );
    expect(mention[0]).toMatchObject({ key: 'C:/repo/README.md', title: 'docs/README.md', detail: 'file' });
    expect(mentionInsertText({ path: 'C:/repo/README.md', relativePath: 'docs/README.md' })).toBe('@README.md ');
  });
});
