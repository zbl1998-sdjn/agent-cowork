// @ts-check
// Kimi CLI 输出解码:优先 UTF-8,Windows 下兼容 GB18030。
import { TextDecoder } from 'node:util';

/** @param {Buffer[]} chunks */
export function decodeCliOutput(chunks) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    if (process.platform === 'win32') {
      try {
        return new TextDecoder('gb18030').decode(buffer);
      } catch {
        // Fall through to Node's replacement decoder.
      }
    }
    return buffer.toString('utf8');
  }
}
