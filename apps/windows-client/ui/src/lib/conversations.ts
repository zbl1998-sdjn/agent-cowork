// 会话工具(UI · 逻辑层 · lib)
// ---------------------------------------------------------------------------
// 职责:多会话历史栏的纯函数(图片路径判定、首条用户消息推断标题、会话导出 Markdown),
// 从 App.tsx 抽出以便脱离 DOM/React 单测。依赖:lib/md 的 extractSuggestions。
// 导出:isImagePath、convTitle、conversationToMarkdown 及 ConvLike/ConvMessageLike 类型。
import { extractSuggestions } from './md';

export interface ConvMessageLike { role: string; text?: string | undefined }
export interface ConvLike { title?: string | undefined; messages: ConvMessageLike[] }

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_RE.test(String(p || ''));
}

// 用首条用户消息推断会话标题(截断到短标题),没有内容时用 fallback。
export function convTitle(msgs: ConvMessageLike[], fallback: string): string {
  const firstUser = msgs.find((m) => m.role === 'user');
  const t = firstUser && firstUser.text ? firstUser.text.trim() : '';
  return t ? t.slice(0, 24) : (fallback || '新对话');
}

// 把会话导出成可移植 Markdown,并剥掉助手消息里的 ```suggestions 内部块。
export function conversationToMarkdown(c: ConvLike): string {
  const lines: string[] = [`# ${c.title || '对话'}`, ''];
  for (const m of c.messages) {
    if (m.role === 'user') {
      lines.push(`**我：** ${m.text || ''}`, '');
    } else {
      const body = extractSuggestions(m.text || '').text;
      lines.push(`**Kimi：** ${body || ''}`, '');
    }
  }
  return lines.join('\n');
}
