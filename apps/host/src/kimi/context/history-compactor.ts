// 历史消息压缩器(host · L1 领域层 · kimi/context)
// ---------------------------------------------------------------------------
// 职责:超出上下文预算时,保留最近若干条、把更早的历史折叠为一条 system 摘要
//       (含关键事实抽取与角色统计),再按 token 预算逐级强制收敛。
// 依赖:同层 token-estimator(估算 token);其余仅标准库。
// 导出:HistoryCompactor(类)、createHistoryCompactor(工厂)。

import { createHeuristicTokenEstimator } from './token-estimator.js';

const DEFAULT_MAX_CONTEXT_TOKENS = 12_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 16;
const DEFAULT_MAX_FACTS = 24;
const FACT_RE = /\b(?:fact|important|decision|constraint|preference)\s*:|(?:关键事实|重要|决定|约束|用户偏好|偏好)\s*[:：]/iu;

type ChatMessageLike = { role?: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown[] };

type TokenEstimatorLike = {
  estimateText(value: unknown): number;
  estimateMessages(messages: ChatMessageLike[]): { totalTokens: number };
};

type HistoryCompactorOptions = { estimator?: TokenEstimatorLike; maxContextTokens?: number; keepRecentMessages?: number; maxFacts?: number };

export type CompactResult = {
  compacted: boolean; beforeTokens: number; afterTokens: number; messages: ChatMessageLike[];
  keyFacts: string[]; summary: string;
};

type EnforcedBudget = { messages: ChatMessageLike[]; tokens: number };

function stableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) || '';
  } catch {
    return String(value);
  }
}

function clipText(text: string, maxChars: number): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 18)).trim()} ...[truncated]`;
}

function cloneMessage(message: ChatMessageLike): ChatMessageLike {
  return { ...message };
}

function contentText(message: ChatMessageLike): string {
  const parts = [message.role, message.name, message.tool_call_id, stableText(message.content)];
  if (Array.isArray(message.tool_calls)) {
    parts.push(stableText(message.tool_calls));
  }
  return parts.filter(Boolean).join('\n');
}

function normalizeMessages(messages: unknown[]): ChatMessageLike[] {
  return Array.isArray(messages)
    ? messages.filter((message) => message && typeof message === 'object').map((message) => cloneMessage(message as ChatMessageLike))
    : [];
}

function extractKeyFacts(messages: ChatMessageLike[], maxFacts: number): string[] {
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const message of messages) {
    const chunks = stableText(message.content).split(/\r?\n|[。；;]/u);
    for (const chunk of chunks) {
      const fact = clipText(chunk, 240);
      if (!fact || !FACT_RE.test(fact)) continue;
      const key = fact.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
      if (facts.length >= maxFacts) return facts;
    }
  }
  return facts;
}

function roleCounts(messages: ChatMessageLike[]): Record<string, number> {
  return messages.reduce((counts, message) => {
    const role = String(message.role || 'unknown');
    counts[role] = (counts[role] || 0) + 1;
    return counts;
  }, {} as Record<string, number>);
}

function buildSummary(oldMessages: ChatMessageLike[], keyFacts: string[]): string {
  const counts = Object.entries(roleCounts(oldMessages)).map(([role, count]) => `${role}:${count}`).join(', ');
  const sample = [...oldMessages.slice(0, 3), ...oldMessages.slice(-3)]
    .map((message) => `- ${message.role || 'unknown'}: ${clipText(stableText(message.content), 180)}`)
    .filter((line) => !line.endsWith(': '));
  const factLines = keyFacts.length ? keyFacts.map((fact) => `- ${fact}`) : ['- none detected'];
  return [
    '[history compacted]',
    'Key facts:',
    ...factLines,
    `Compacted ${oldMessages.length} older messages. Role counts: ${counts || 'none'}.`,
    'Older-history sketch:',
    ...sample,
  ].join('\n');
}

function estimateMessages(estimator: TokenEstimatorLike, messages: ChatMessageLike[]): number {
  return Math.max(0, Math.round(estimator.estimateMessages(messages).totalTokens || 0));
}

function clipToTokenBudget(text: string, maxTokens: number, estimator: TokenEstimatorLike): string {
  if (maxTokens <= 0) return '';
  if (estimator.estimateText(text) <= maxTokens) return text;
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

function trimMessageContent(message: ChatMessageLike, maxTokens: number, estimator: TokenEstimatorLike): ChatMessageLike {
  const marker = '[content compacted to fit context]';
  const text = stableText(message.content);
  const body = clipToTokenBudget(text, Math.max(1, maxTokens - estimator.estimateText(marker)), estimator);
  return { ...message, content: body ? `${marker}\n${body}` : marker };
}

function trimWholeMessageToBudget(
  message: ChatMessageLike,
  maxMessageTokens: number,
  estimator: TokenEstimatorLike,
): ChatMessageLike {
  const marker = '[content compacted to fit context]';
  const original = stableText(message.content);
  let best = { ...message, content: marker };
  let low = 0;
  let high = original.length;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = {
      ...message,
      content: `${marker}\n${original.slice(0, mid).trim()}${mid < original.length ? ' ...[truncated]' : ''}`,
    };
    if (estimateMessages(estimator, [candidate]) <= maxMessageTokens) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * 多级强制收敛:依次裁中间消息正文、裁首条、丢弃中段、裁次条,直至落入预算。
 */
function enforceBudget(messages: ChatMessageLike[], maxContextTokens: number, estimator: TokenEstimatorLike): EnforcedBudget {
  let compacted = messages.map(cloneMessage);
  let tokens = estimateMessages(estimator, compacted);
  for (let i = 1; i < compacted.length - 1 && tokens > maxContextTokens; i += 1) {
    const overage = tokens - maxContextTokens;
    const current = estimator.estimateText(contentText(compacted[i]));
    compacted[i] = trimMessageContent(compacted[i], Math.max(1, current - overage - 16), estimator);
    tokens = estimateMessages(estimator, compacted);
  }
  if (tokens > maxContextTokens && compacted.length > 0) {
    const otherTokens = estimateMessages(estimator, compacted.slice(1));
    compacted[0] = trimWholeMessageToBudget(compacted[0], Math.max(1, maxContextTokens - otherTokens), estimator);
    tokens = estimateMessages(estimator, compacted);
  }
  while (tokens > maxContextTokens && compacted.length > 2) {
    compacted = [compacted[0], ...compacted.slice(2)];
    tokens = estimateMessages(estimator, compacted);
  }
  if (tokens > maxContextTokens && compacted.length > 1) {
    compacted[1] = trimWholeMessageToBudget(compacted[1], Math.max(1, maxContextTokens - estimateMessages(estimator, [compacted[0]])), estimator);
    tokens = estimateMessages(estimator, compacted);
  }
  if (tokens > maxContextTokens && compacted.length === 1) {
    compacted[0] = trimWholeMessageToBudget(compacted[0], maxContextTokens, estimator);
    tokens = estimateMessages(estimator, compacted);
  }
  return { messages: compacted, tokens };
}

export class HistoryCompactor {
  estimator: TokenEstimatorLike;
  maxContextTokens: number;
  keepRecentMessages: number;
  maxFacts: number;

  constructor(options: HistoryCompactorOptions = {}) {
    this.estimator = options.estimator || createHeuristicTokenEstimator();
    this.maxContextTokens = Math.max(1, Math.round(Number(options.maxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS));
    this.keepRecentMessages = Math.max(1, Math.round(Number(options.keepRecentMessages) || DEFAULT_KEEP_RECENT_MESSAGES));
    this.maxFacts = Math.max(1, Math.round(Number(options.maxFacts) || DEFAULT_MAX_FACTS));
  }

  /**
   * 压缩历史:未超预算则原样返回;否则折叠旧消息为摘要并强制收敛到预算内。
   */
  compact(messages: unknown[], options: Omit<HistoryCompactorOptions, 'estimator'> = {}): CompactResult {
    const normalized = normalizeMessages(messages);
    const maxContextTokens = Math.max(1, Math.round(Number(options.maxContextTokens) || this.maxContextTokens));
    const keepRecentMessages = Math.max(1, Math.round(Number(options.keepRecentMessages) || this.keepRecentMessages));
    const maxFacts = Math.max(1, Math.round(Number(options.maxFacts) || this.maxFacts));
    const beforeTokens = estimateMessages(this.estimator, normalized);
    const keyFacts = extractKeyFacts(normalized, maxFacts);
    if (beforeTokens <= maxContextTokens) {
      return { compacted: false, beforeTokens, afterTokens: beforeTokens, messages: normalized, keyFacts, summary: '' };
    }

    const recent = normalized.slice(-keepRecentMessages);
    const old = normalized.slice(0, Math.max(0, normalized.length - recent.length));
    let summary = buildSummary(old, keyFacts);
    let compacted: ChatMessageLike[] = [{ role: 'system', name: 'history_compactor', content: summary }, ...recent];
    let afterTokens = estimateMessages(this.estimator, compacted);
    if (afterTokens > maxContextTokens) {
      const recentTokens = estimateMessages(this.estimator, recent);
      if (recentTokens < maxContextTokens - 32) {
        const summaryBudget = Math.max(1, maxContextTokens - recentTokens - 8);
        summary = clipToTokenBudget(summary, summaryBudget, this.estimator);
        compacted = [{ role: 'system', name: 'history_compactor', content: summary }, ...recent];
        afterTokens = estimateMessages(this.estimator, compacted);
      }
    }

    const enforced = enforceBudget(compacted, maxContextTokens, this.estimator);
    return {
      compacted: true,
      beforeTokens,
      afterTokens: enforced.tokens,
      messages: enforced.messages,
      keyFacts,
      summary: stableText(enforced.messages[0]?.content || summary),
    };
  }
}

/** 创建 HistoryCompactor 实例的工厂(便于注入估算器与阈值)。 */
export function createHistoryCompactor(options: HistoryCompactorOptions = {}): HistoryCompactor {
  return new HistoryCompactor(options);
}
