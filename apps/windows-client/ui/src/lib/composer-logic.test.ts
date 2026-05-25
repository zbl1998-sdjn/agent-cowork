import { describe, expect, it } from 'vitest';
import { buildSessionModelConfig, MENTION_SEARCH_DEBOUNCE_MS, resolveRefineSendDecision, shouldDebounceMentionSearch, shouldRefineBeforeSend } from './composer-logic';
import type { PromptRefineResult } from './api/prompt';

const base: PromptRefineResult = {
  refined: '请总结 README 并列出风险',
  changed: false,
  intent: 'summarize',
  missing: [],
};

describe('composer refine send logic', () => {
  it('only refines non-empty text when auto clarify is enabled', () => {
    expect(shouldRefineBeforeSend(true, ' 看看这个 ')).toBe(true);
    expect(shouldRefineBeforeSend(true, '   ')).toBe(false);
    expect(shouldRefineBeforeSend(false, '看看这个')).toBe(false);
  });

  it('continues sending when refinement has no visible change', () => {
    expect(resolveRefineSendDecision(' 看看 README ', base)).toEqual({
      action: 'send',
      text: '看看 README',
    });
  });

  it('pauses for preview when the prompt was rewritten or still misses fields', () => {
    expect(resolveRefineSendDecision('看看这个', { ...base, changed: true }).action).toBe('preview');
    expect(resolveRefineSendDecision('看看这个', { ...base, missing: ['目标文件'] }).action).toBe('preview');
  });

  it('debounces file mention searches only when there is a query', () => {
    expect(MENTION_SEARCH_DEBOUNCE_MS).toBeGreaterThan(50);
    expect(shouldDebounceMentionSearch('readme')).toBe(true);
    expect(shouldDebounceMentionSearch('   ')).toBe(false);
  });

  it('builds per-session model config only from explicit overrides', () => {
    expect(buildSessionModelConfig({
      provider: 'kimi-api',
      model: 'moonshot-v1',
      baseUrl: 'https://api.moonshot.test/v1/',
      apiKey: '   ',
    }, {
      provider: 'kimi-api',
      model: 'moonshot-v1',
      baseUrl: 'https://api.moonshot.test/v1',
    })).toBeUndefined();

    expect(buildSessionModelConfig({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: ' https://api.openai.test/v1/ ',
      apiKey: ' sk-session ',
    }, {
      provider: 'kimi-api',
      model: 'moonshot-v1',
      baseUrl: 'https://api.moonshot.test/v1',
    })).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: 'https://api.openai.test/v1',
      apiKey: 'sk-session',
    });
  });
});
