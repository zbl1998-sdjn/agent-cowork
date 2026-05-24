import type { PromptRefineResult } from './api/prompt';

export const MENTION_SEARCH_DEBOUNCE_MS = 120;

export type RefineSendDecision =
  | { action: 'send'; text: string }
  | { action: 'preview'; result: PromptRefineResult };

export function shouldRefineBeforeSend(autoClarify: boolean, text: string): boolean {
  return autoClarify && text.trim().length > 0;
}

export function resolveRefineSendDecision(original: string, result: PromptRefineResult): RefineSendDecision {
  if (result.changed || result.missing.length > 0) return { action: 'preview', result };
  return { action: 'send', text: original.trim() };
}

export function shouldDebounceMentionSearch(query: string): boolean {
  return query.trim().length > 0;
}
