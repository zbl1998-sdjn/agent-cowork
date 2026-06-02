// 文档抽取·纯工具(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:document-extractor 用到的无副作用工具——字节上限夹取、SHA-256、XML 实体解码、
//       多行压实/截断、XML→纯文本、PDF 字面串解码(含八进制转义)。易单测。
// 依赖:node:crypto。导出:cappedMaxBytes/sha256/decodeXmlEntities/compactLines/xmlToText/decodePdfLiteral。
import crypto from 'node:crypto';

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function cappedMaxBytes(value: unknown, fallback = DEFAULT_MAX_BYTES): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), DEFAULT_MAX_BYTES);
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function decodeXmlEntities(text: unknown): string {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function compactLines(text: unknown, maxChars = 12000): string {
  const compacted = String(text || '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}\n[内容已截断]` : compacted;
}

export function xmlToText(xml: unknown): string {
  return compactLines(
    decodeXmlEntities(
      String(xml || '')
        .replace(/<\?xml[^>]*>/gi, ' ')
        .replace(/<w:tab\s*\/>/gi, '\t')
        .replace(/<a:br\s*\/>/gi, '\n')
        .replace(/<\/(?:w:p|a:p|p|row|worksheet|si)>/gi, '\n')
        .replace(/<\/(?:w:tr|a:tr|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

export function decodePdfLiteral(input: string): string {
  let output = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? '';
    if (ch !== '\\') {
      output += ch;
      continue;
    }
    const next = input[i + 1] ?? '';
    i += 1;
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b') output += '\b';
    else if (next === 'f') output += '\f';
    else if (/[0-7]/.test(next || '')) {
      let octal = next;
      for (let j = 0; j < 2; j += 1) {
        const digit = input[i + 1];
        if (!digit || !/[0-7]/.test(digit)) break;
        octal += digit;
        i += 1;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      output += next || '';
    }
  }
  return output;
}
