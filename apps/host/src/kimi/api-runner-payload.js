// @ts-check
// Kimi API 响应体解析:兼容 OpenAI content 字符串和多段数组。
import { cleanText } from './api-runner-config.js';

/**
 * @typedef {{ usage?: unknown, choices?: Array<{ message?: { content?: unknown }, delta?: { content?: unknown, reasoning_content?: unknown } }> }} KimiPayload
 */

/** 从响应体里提取首条 message 文本。 @param {unknown} payload @returns {string} */
export function extractMessageText(payload) {
  const data = /** @type {KimiPayload} */ (payload && typeof payload === 'object' ? payload : {});
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    return cleanText(
      content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .filter(Boolean)
        .join('\n'),
    );
  }
  return '';
}
