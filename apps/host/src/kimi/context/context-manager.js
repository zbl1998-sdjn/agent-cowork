// @ts-check

// 对话上下文统一编排门面(host · L1 领域层 · kimi/context)
// ---------------------------------------------------------------------------
// 职责:对外暴露 ContextManager,把历史压缩、工具结果摘要与不可信内容防护
//       串成一条管线;按 token 预算裁剪工具结果并标注其可信度。
// 依赖:同层 token-estimator / history-compactor / tool-result-summarizer +
//       safety/untrusted-content(同属 L1,无向上依赖)。
// 导出:ContextManager(类)、createContextManager(工厂)。

import { createHeuristicTokenEstimator } from './token-estimator.js';
import { createHistoryCompactor } from './history-compactor.js';
import { createToolResultSummarizer } from './tool-result-summarizer.js';
import { createInjectionGuard } from '../safety/untrusted-content.js';

/**
 * @typedef {{ role?: string, content?: unknown, name?: string, tool_call_id?: string, tool_calls?: unknown[] }} ChatMessageLike
 * @typedef {{ estimateText(value: unknown): number, estimateMessages(messages: ChatMessageLike[]): { totalTokens: number } }} TokenEstimatorLike
 * @typedef {{ compact(messages: unknown[], options?: Record<string, unknown>): { compacted: boolean, beforeTokens: number, afterTokens: number, messages: ChatMessageLike[], keyFacts?: string[], summary?: string } }} HistoryCompactorLike
 * @typedef {{ shrink(result: unknown, options?: Record<string, unknown>): { summarized: boolean, beforeTokens: number, afterTokens: number, content: string, sources?: string[], keyPoints?: string[] } }} ToolResultSummarizerLike
 * @typedef {{ wrap(value: unknown, meta?: { source?: string, toolName?: string }): { content: string, wrapped: boolean, alreadyWrapped?: boolean, flagged: boolean, reasons: string[] } }} InjectionGuardLike
 */

/**
 * 用二分查找把文本裁到不超过 token 预算(尾部加截断标记)。
 * @param {string} text
 * @param {number} maxTokens
 * @param {TokenEstimatorLike} estimator
 * @returns {string}
 */
function clipToTokenBudget(text, maxTokens, estimator) {
  if (maxTokens <= 0 || estimator.estimateText(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${text.slice(0, mid).trim()} ...[truncated]`;
    if (estimator.estimateText(candidate) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low).trim()} ...[truncated]`;
}

export class ContextManager {
  /**
   * @param {{
   *   estimator?: TokenEstimatorLike,
   *   historyCompactor?: HistoryCompactorLike,
   *   toolResultSummarizer?: ToolResultSummarizerLike,
   *   injectionGuard?: InjectionGuardLike,
   *   maxContextTokens?: number,
   *   keepRecentMessages?: number,
   *   maxFacts?: number,
   *   maxToolResultTokens?: number,
   *   maxSources?: number,
   *   maxKeyPoints?: number,
   * }} [options]
   */
  constructor(options = {}) {
    const estimator = options.estimator || createHeuristicTokenEstimator();
    this.estimator = estimator;
    this.maxToolResultTokens = Math.max(0, Math.round(Number(options.maxToolResultTokens) || 0));
    this.injectionGuard = options.injectionGuard || createInjectionGuard();
    this.historyCompactor = options.historyCompactor || createHistoryCompactor({
      estimator,
      maxContextTokens: options.maxContextTokens,
      keepRecentMessages: options.keepRecentMessages,
      maxFacts: options.maxFacts,
    });
    this.toolResultSummarizer = options.toolResultSummarizer || createToolResultSummarizer({
      estimator,
      maxTokens: options.maxToolResultTokens,
      maxSources: options.maxSources,
      maxKeyPoints: options.maxKeyPoints,
    });
  }

  /**
   * 压缩历史消息以适配上下文 token 预算,返回压缩结果。
   * @param {unknown[]} messages
   * @param {{ maxContextTokens?: number, keepRecentMessages?: number, maxFacts?: number }} [options]
   */
  prepareMessages(messages, options = {}) {
    return this.historyCompactor.compact(messages, options);
  }

  /**
   * 摘要工具结果、套上不可信内容防护壳,并按 token 预算二次裁剪。
   * @param {unknown} result
   * @param {{ maxToolResultTokens?: number, maxTokens?: number, maxSources?: number, maxKeyPoints?: number, toolName?: string }} [options]
   */
  formatToolResult(result, options = {}) {
    const maxTokens = Math.max(0, Math.round(Number(options.maxToolResultTokens || options.maxTokens || this.maxToolResultTokens) || 0));
    const output = this.toolResultSummarizer.shrink(result, {
      maxTokens: options.maxToolResultTokens || options.maxTokens,
      maxSources: options.maxSources,
      maxKeyPoints: options.maxKeyPoints,
    });
    const meta = { source: 'tool', toolName: options.toolName };
    let guarded = this.injectionGuard.wrap(output.content, meta);
    let afterTokens = this.estimator.estimateText(guarded.content);
    if (maxTokens > 0 && afterTokens > maxTokens) {
      // 防护壳本身有固定开销;先量空壳开销,再把正文裁到剩余预算内。
      const overhead = this.estimator.estimateText(this.injectionGuard.wrap('', meta).content);
      const bodyBudget = Math.max(1, maxTokens - overhead);
      guarded = this.injectionGuard.wrap(clipToTokenBudget(output.content, bodyBudget, this.estimator), meta);
      afterTokens = this.estimator.estimateText(guarded.content);
    }
    return {
      ...output,
      content: guarded.content,
      afterTokens,
      untrusted: guarded.wrapped,
      injectionFlagged: guarded.flagged,
      injectionReasons: guarded.reasons,
    };
  }
}

/**
 * 创建 ContextManager 实例的工厂(便于注入依赖与测试)。
 * @param {ConstructorParameters<typeof ContextManager>[0]} [options]
 * @returns {ContextManager}
 */
export function createContextManager(options = {}) {
  return new ContextManager(options);
}
