// 历史压缩纯工具(host · L1 领域层 · engine/context)
// ---------------------------------------------------------------------------
// 职责:HistoryCompactor 使用的消息规范化、文本稳定化与裁剪工具。
export type ChatMessageLike = { role?: string; content?: unknown; name?: string; tool_call_id?: string; tool_calls?: unknown[] };

export type TokenEstimatorLike = {
  estimateText(value: unknown): number;
  estimateMessages(messages: ChatMessageLike[]): { totalTokens: number };
};

export function stableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value) || '';
  } catch {
    return String(value);
  }
}

export function clipText(text: string, maxChars: number): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 18)).trim()} ...[truncated]`;
}

export function cloneMessage(message: ChatMessageLike): ChatMessageLike {
  return { ...message };
}

export function contentText(message: ChatMessageLike): string {
  const parts = [message.role, message.name, message.tool_call_id, stableText(message.content)];
  if (Array.isArray(message.tool_calls)) {
    parts.push(stableText(message.tool_calls));
  }
  return parts.filter(Boolean).join('\n');
}

export function normalizeMessages(messages: unknown[]): ChatMessageLike[] {
  return Array.isArray(messages)
    ? messages.filter((message) => message && typeof message === 'object').map((message) => cloneMessage(message as ChatMessageLike))
    : [];
}
