// Kimi API 响应体解析(host · L1 领域层 · kimi)
// ---------------------------------------------------------------------------
// 职责:从 Kimi/OpenAI 风格的响应体中提取首条 message 文本;兼容 content 为
//       字符串或多段数组(各段取 string 或 { text } 字段),拼接后做清洗。
// 依赖:同层 ./api-runner-config.js(cleanText)。导出:extractMessageText。
import { cleanText } from './api-runner-config.js';

type ModelApiPayload = {
  usage?: unknown;
  choices?: Array<{
    message?: { content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown };
  }>;
};

/** 从响应体里提取首条 message 文本。 */
export function extractMessageText(payload: unknown): string {
  const data = (payload && typeof payload === 'object' ? payload : {}) as ModelApiPayload;
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
