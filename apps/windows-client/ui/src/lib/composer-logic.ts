// 输入框逻辑(UI · lib):聊天输入区的纯逻辑——草稿拼装、提示词精炼结果合并、模型配置整理等,
// 供 Composer 组件调用而不内嵌业务逻辑。依赖:api/prompt、api/chat 类型。
import type { PromptRefineResult } from './api/prompt';
import type { ModelRunConfig } from './api/chat';

export const MENTION_SEARCH_DEBOUNCE_MS = 120;

export type RefineSendDecision =
  | { action: 'send'; text: string }
  | { action: 'preview'; result: PromptRefineResult };

export function shouldRefineBeforeSend(autoClarify: boolean, text: string): boolean {
  return autoClarify && text.trim().length > 0;
}

export function resolveRefineSendDecision(original: string, result: PromptRefineResult): RefineSendDecision {
  if (result.changed || result.needsClarification) return { action: 'preview', result };
  return { action: 'send', text: original.trim() };
}

export function shouldDebounceMentionSearch(query: string): boolean {
  return query.trim().length > 0;
}

function clean(value?: string): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

export function buildSessionModelConfig(
  draft: ModelRunConfig,
  defaults: ModelRunConfig = {},
): ModelRunConfig | undefined {
  const next: ModelRunConfig = {};
  const provider = clean(draft.provider);
  const model = clean(draft.model);
  const baseUrl = clean(draft.baseUrl)?.replace(/\/+$/, '');
  const apiKey = clean(draft.apiKey);
  const defaultProvider = clean(defaults.provider);
  const defaultModel = clean(defaults.model);
  const defaultBaseUrl = clean(defaults.baseUrl)?.replace(/\/+$/, '');

  if (provider && provider !== defaultProvider) next.provider = provider;
  if (model && model !== defaultModel) next.model = model;
  if (baseUrl && baseUrl !== defaultBaseUrl) next.baseUrl = baseUrl;
  if (apiKey) next.apiKey = apiKey;
  return Object.keys(next).length ? next : undefined;
}
