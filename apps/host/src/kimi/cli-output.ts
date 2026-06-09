// Kimi CLI 子进程输出解码(host · L0 基础层 · kimi)
// ---------------------------------------------------------------------------
// 职责:把 CLI 进程的原始字节块解码为字符串,优先 UTF-8;Windows 下回退 GB18030,
//       仍失败则用 Node 替换式解码兜底,避免乱码中断对话。
// 依赖:标准库(node:util 的 TextDecoder)。导出:decodeCliOutput。
import { TextDecoder } from 'node:util';

/** 把 CLI 输出字节块拼接并按 UTF-8 优先、Windows 回退 GB18030 的策略解码为字符串。 */
export function decodeCliOutput(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    if (process.platform === 'win32') {
      try {
        return new TextDecoder('gb18030').decode(buffer);
      } catch {
        // 继续退回 Node 的替换式 UTF-8 解码器。
      }
    }
    return buffer.toString('utf8');
  }
}
