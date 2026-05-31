// Kimi API 响应体解析:兼容 OpenAI content 字符串和多段数组。
import { cleanText } from './api-runner-config.js';

type KimiPayload = {
  usage?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown };
  }>;
};

/** 从响应体里提取首条 message 文本。 */
export function extractMessageText(payload: unknown): string {
  const data = (payload && typeof payload === 'object' ? payload : {}) as KimiPayload;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    return cleanText(
      content
        .map((part: unknown) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
            return (part as { text: string }).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  return '';
}
