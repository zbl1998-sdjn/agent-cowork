// 启发式 token 估算器(host · L1 领域层 · kimi/context)
// ---------------------------------------------------------------------------
// 职责:无需远程分词器,按「CJK 字符约 1 token + 其余字符按比例折算」估算
//       文本与整组消息的 token 数,供压缩/摘要的预算决策使用。
// 依赖:仅标准库。
// 导出:HeuristicTokenEstimator(类)、createHeuristicTokenEstimator(工厂)。

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 3;
const DEFAULT_REPLY_PRIMER_TOKENS = 3;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

type ChatMessageLike = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type MessageTokenEstimate = {
  index: number;
  role: string;
  textTokens: number;
  overheadTokens: number;
  totalTokens: number;
};

export type MessagesTokenEstimate = {
  method: 'heuristic-v1';
  messageCount: number;
  textTokens: number;
  overheadTokens: number;
  totalTokens: number;
  messages: MessageTokenEstimate[];
};

type HeuristicTokenEstimatorOptions = {
  charsPerToken?: number;
  messageOverheadTokens?: number;
  replyPrimerTokens?: number;
};

function stableText(value: unknown): string {
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

function countCjk(value: unknown): number {
  return Array.from(stableText(value).matchAll(CJK_RE)).length;
}

function stripCjk(text: string): string {
  return text.replace(CJK_RE, '');
}

function toolCallText(call: unknown): string {
  if (!call || typeof call !== 'object') return stableText(call);
  const record = call as Record<string, unknown>;
  const fn = record.function && typeof record.function === 'object'
    ? record.function as Record<string, unknown>
    : {};
  return [
    record.id,
    record.type,
    fn.name,
    fn.arguments,
  ].map(stableText).filter(Boolean).join('\n');
}

function messageText(message: ChatMessageLike | string | null | undefined): string {
  if (!message || typeof message !== 'object') return stableText(message);
  const record = message;
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
  charsPerToken: number;

  messageOverheadTokens: number;

  replyPrimerTokens: number;

  constructor(options: HeuristicTokenEstimatorOptions = {}) {
    this.charsPerToken = Math.max(1, Number(options.charsPerToken) || DEFAULT_CHARS_PER_TOKEN);
    this.messageOverheadTokens = Math.max(0, Math.round(Number(options.messageOverheadTokens) || DEFAULT_MESSAGE_OVERHEAD_TOKENS));
    this.replyPrimerTokens = Math.max(0, Math.round(Number(options.replyPrimerTokens) || DEFAULT_REPLY_PRIMER_TOKENS));
  }

  /** 估算单段文本的 token 数:CJK 逐字计、其余按字符数折算。 */
  estimateText(value: unknown): number {
    const text = stableText(value);
    if (!text) return 0;
    const cjkTokens = countCjk(text);
    const nonCjkChars = stripCjk(text).replace(/\s+/g, '').length;
    return cjkTokens + Math.ceil(nonCjkChars / this.charsPerToken);
  }

  /**
   * 估算整组消息的 token 数:逐条文本 token + 每条固定开销 + 回复引导开销。
   */
  estimateMessages(messages: Array<ChatMessageLike | string | null | undefined>): MessagesTokenEstimate {
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

/** 创建启发式 token 估算器实例的工厂。 */
export function createHeuristicTokenEstimator(options: HeuristicTokenEstimatorOptions = {}): HeuristicTokenEstimator {
  return new HeuristicTokenEstimator(options);
}
