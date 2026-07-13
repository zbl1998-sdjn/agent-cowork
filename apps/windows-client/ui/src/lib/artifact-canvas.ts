import type { AssistantMessage, Message } from './app-types';

export type ArtifactBlockKind = 'heading' | 'paragraph' | 'list' | 'code';

export interface ArtifactBlock {
  id: string;
  kind: ArtifactBlockKind;
  text: string;
  start: number;
  end: number;
}

export interface ArtifactMessage {
  id: string;
  text: string;
  status: AssistantMessage['status'];
}

const LIST_RE = /^\s*(?:[-*+] |\d+\. )/;

function kindOf(line: string): ArtifactBlockKind {
  if (line.startsWith('```')) return 'code';
  if (/^#{1,6}\s/.test(line)) return 'heading';
  if (LIST_RE.test(line)) return 'list';
  return 'paragraph';
}

export function parseArtifactBlocks(text: string): ArtifactBlock[] {
  const lines = [...text.matchAll(/.*(?:\n|$)/g)]
    .map((match) => ({ text: match[0].replace(/\n$/, ''), start: match.index, end: match.index + match[0].replace(/\n$/, '').length }))
    .filter((line, index, all) => line.text || index < all.length - 1);
  const blocks: ArtifactBlock[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    if (!lines[cursor]?.text.trim()) { cursor += 1; continue; }
    const startLine = lines[cursor];
    if (!startLine) break;
    const kind = kindOf(startLine.text);
    let endCursor = cursor;
    if (kind === 'code') {
      while (endCursor + 1 < lines.length) {
        endCursor += 1;
        if (lines[endCursor]?.text.startsWith('```')) break;
      }
    } else if (kind === 'list') {
      while (endCursor + 1 < lines.length && LIST_RE.test(lines[endCursor + 1]?.text || '')) endCursor += 1;
    } else if (kind === 'paragraph') {
      while (endCursor + 1 < lines.length && lines[endCursor + 1]?.text.trim() && kindOf(lines[endCursor + 1]?.text || '') === 'paragraph') endCursor += 1;
    }
    const endLine = lines[endCursor];
    if (!endLine) break;
    blocks.push({ id: `block-${blocks.length + 1}`, kind, text: text.slice(startLine.start, endLine.end), start: startLine.start, end: endLine.end });
    cursor = endCursor + 1;
  }
  return blocks;
}

export function replaceArtifactBlock(source: string, block: ArtifactBlock, nextText: string): string {
  return `${source.slice(0, block.start)}${nextText}${source.slice(block.end)}`;
}

export function buildArtifactRevisionPrompt(block: ArtifactBlock, instruction: string, annotation = ''): string {
  const note = annotation.trim() ? `\n批注：${annotation.trim()}` : '';
  return `只修改下面选中的成果片段，保留其他内容和原有结构。\n\n选中片段：\n${block.text}\n\n修改要求：${instruction.trim()}${note}`;
}

export function latestArtifactMessage(messages: Message[]): ArtifactMessage | null {
  const message = [...messages].reverse().find((item): item is AssistantMessage => item.role === 'assistant' && item.status !== 'failed' && item.status !== 'cancelled' && Boolean(item.text?.trim()));
  return message ? { id: message.id, text: message.text || '', status: message.status } : null;
}
