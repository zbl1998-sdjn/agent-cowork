// Pure, testable helpers for the multi-conversation history rail. Kept out of
// App.tsx so they can be unit-tested without a DOM/React harness.
import { extractSuggestions } from './md';

export interface ConvMessageLike { role: string; text?: string }
export interface ConvLike { title?: string; messages: ConvMessageLike[] }

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function isImagePath(p: string): boolean {
  return IMAGE_RE.test(String(p || ''));
}

// Derive a conversation title from its first user message (clamped), else fallback.
export function convTitle(msgs: ConvMessageLike[], fallback: string): string {
  const firstUser = msgs.find((m) => m.role === 'user');
  const t = firstUser && firstUser.text ? firstUser.text.trim() : '';
  return t ? t.slice(0, 24) : (fallback || '新对话');
}

// Render a conversation to portable Markdown (assistant ```suggestions blocks stripped).
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
