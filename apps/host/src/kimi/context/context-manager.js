// @ts-check

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
   * @param {unknown[]} messages
   * @param {{ maxContextTokens?: number, keepRecentMessages?: number, maxFacts?: number }} [options]
   */
  prepareMessages(messages, options = {}) {
    return this.historyCompactor.compact(messages, options);
  }

  /**
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
 * @param {ConstructorParameters<typeof ContextManager>[0]} [options]
 * @returns {ContextManager}
 */
export function createContextManager(options = {}) {
  return new ContextManager(options);
}
