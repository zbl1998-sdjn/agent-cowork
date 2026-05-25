// @ts-check

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 3;
const DEFAULT_REPLY_PRIMER_TOKENS = 3;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * @typedef {{ role?: string, content?: unknown, name?: string, tool_call_id?: string, tool_calls?: unknown[] }} ChatMessageLike
 * @typedef {{ index: number, role: string, textTokens: number, overheadTokens: number, totalTokens: number }} MessageTokenEstimate
 * @typedef {{ method: 'heuristic-v1', messageCount: number, textTokens: number, overheadTokens: number, totalTokens: number, messages: MessageTokenEstimate[] }} MessagesTokenEstimate
 */

/** @param {unknown} value @returns {string} */
function stableText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value) || '';
  } catch {
    return String(value);
  }
}

/** @param {unknown} value @returns {number} */
function countCjk(value) {
  return Array.from(stableText(value).matchAll(CJK_RE)).length;
}

/** @param {string} text @returns {string} */
function stripCjk(text) {
  return text.replace(CJK_RE, '');
}

/** @param {unknown} call @returns {string} */
function toolCallText(call) {
  if (!call || typeof call !== 'object') return stableText(call);
  const record = /** @type {Record<string, unknown>} */ (call);
  const fn = record.function && typeof record.function === 'object'
    ? /** @type {Record<string, unknown>} */ (record.function)
    : {};
  return [
    record.id,
    record.type,
    fn.name,
    fn.arguments,
  ].map(stableText).filter(Boolean).join('\n');
}

/** @param {ChatMessageLike | string | null | undefined} message @returns {string} */
function messageText(message) {
  if (!message || typeof message !== 'object') return stableText(message);
  const record = /** @type {ChatMessageLike} */ (message);
  const parts = [
    record.role,
    record.name,
    record.tool_call_id,
    stableText(record.content),
  ];
  if (Array.isArray(record.tool_calls)) {
    parts.push(...record.tool_calls.map(toolCallText));
  }
  return parts.map(stableText).filter(Boolean).join('\n');
}

export class HeuristicTokenEstimator {
  /**
   * @param {{ charsPerToken?: number, messageOverheadTokens?: number, replyPrimerTokens?: number }} [options]
   */
  constructor(options = {}) {
    this.charsPerToken = Math.max(1, Number(options.charsPerToken) || DEFAULT_CHARS_PER_TOKEN);
    this.messageOverheadTokens = Math.max(0, Math.round(Number(options.messageOverheadTokens) || DEFAULT_MESSAGE_OVERHEAD_TOKENS));
    this.replyPrimerTokens = Math.max(0, Math.round(Number(options.replyPrimerTokens) || DEFAULT_REPLY_PRIMER_TOKENS));
  }

  /** @param {unknown} value @returns {number} */
  estimateText(value) {
    const text = stableText(value);
    if (!text) return 0;
    const cjkTokens = countCjk(text);
    const nonCjkChars = stripCjk(text).replace(/\s+/g, '').length;
    return cjkTokens + Math.ceil(nonCjkChars / this.charsPerToken);
  }

  /**
   * @param {Array<ChatMessageLike | string | null | undefined>} messages
   * @returns {MessagesTokenEstimate}
   */
  estimateMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    const estimates = list.map((message, index) => {
      const textTokens = this.estimateText(messageText(message));
      const overheadTokens = this.messageOverheadTokens;
      return {
        index,
        role: typeof message === 'object' && message && 'role' in message ? String(message.role || '') : '',
        textTokens,
        overheadTokens,
        totalTokens: textTokens + overheadTokens,
      };
    });
    const textTokens = estimates.reduce((sum, item) => sum + item.textTokens, 0);
    const messageOverhead = estimates.reduce((sum, item) => sum + item.overheadTokens, 0);
    const overheadTokens = messageOverhead + this.replyPrimerTokens;
    return {
      method: 'heuristic-v1',
      messageCount: estimates.length,
      textTokens,
      overheadTokens,
      totalTokens: textTokens + overheadTokens,
      messages: estimates,
    };
  }
}

/**
 * @param {{ charsPerToken?: number, messageOverheadTokens?: number, replyPrimerTokens?: number }} [options]
 * @returns {HeuristicTokenEstimator}
 */
export function createHeuristicTokenEstimator(options = {}) {
  return new HeuristicTokenEstimator(options);
}
