import crypto from 'node:crypto';

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** @param {unknown} value @param {number} [fallback] @returns {number} */
export function cappedMaxBytes(value, fallback = DEFAULT_MAX_BYTES) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), DEFAULT_MAX_BYTES);
}

/** @param {Buffer} buffer @returns {string} */
export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** @param {unknown} text @returns {string} */
export function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** @param {unknown} text @param {number} [maxChars] @returns {string} */
export function compactLines(text, maxChars = 12000) {
  const compacted = String(text || '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}\n[内容已截断]` : compacted;
}

/** @param {unknown} xml @returns {string} */
export function xmlToText(xml) {
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

/** @param {string} input @returns {string} */
export function decodePdfLiteral(input) {
  let output = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== '\\') {
      output += ch;
      continue;
    }
    const next = input[i + 1];
    i += 1;
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b') output += '\b';
    else if (next === 'f') output += '\f';
    else if (/[0-7]/.test(next || '')) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(input[i + 1] || ''); j += 1) {
        octal += input[i + 1];
        i += 1;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      output += next || '';
    }
  }
  return output;
}
