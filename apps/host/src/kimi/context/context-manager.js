// @ts-check

import { createHeuristicTokenEstimator } from './token-estimator.js';
import { createHistoryCompactor } from './history-compactor.js';
import { createToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * @typedef {{ role?: string, content?: unknown, name?: string, tool_call_id?: string, tool_calls?: unknown[] }} ChatMessageLike
 * @typedef {{ estimateText(value: unknown): number, estimateMessages(messages: ChatMessageLike[]): { totalTokens: number } }} TokenEstimatorLike
 * @typedef {{ compact(messages: unknown[], options?: Record<string, unknown>): { compacted: boolean, beforeTokens: number, afterTokens: number, messages: ChatMessageLike[], keyFacts?: string[], summary?: string } }} HistoryCompactorLike
 * @typedef {{ shrink(result: unknown, options?: Record<string, unknown>): { summarized: boolean, beforeTokens: number, afterTokens: number, content: string, sources?: string[], keyPoints?: string[] } }} ToolResultSummarizerLike
 */

export class ContextManager {
  /**
   * @param {{
   *   estimator?: TokenEstimatorLike,
   *   historyCompactor?: HistoryCompactorLike,
   *   toolResultSummarizer?: ToolResultSummarizerLike,
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
   * @param {unknown[]} messages
   * @param {{ maxContextTokens?: number, keepRecentMessages?: number, maxFacts?: number }} [options]
   */
  prepareMessages(messages, options = {}) {
    return this.historyCompactor.compact(messages, options);
  }

  /**
   * @param {unknown} result
   * @param {{ maxToolResultTokens?: number, maxTokens?: number, maxSources?: number, maxKeyPoints?: number }} [options]
   */
  formatToolResult(result, options = {}) {
    return this.toolResultSummarizer.shrink(result, {
      maxTokens: options.maxToolResultTokens || options.maxTokens,
      maxSources: options.maxSources,
      maxKeyPoints: options.maxKeyPoints,
    });
  }
}

/**
 * @param {ConstructorParameters<typeof ContextManager>[0]} [options]
 * @returns {ContextManager}
 */
export function createContextManager(options = {}) {
  return new ContextManager(options);
}
