//
// 文本文件读取(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:安全读取工作区内的「文本」文件——路径经可读工作区校验、限制大小(默认/硬上限 256KB)、
//       拒绝疑似二进制文件,返回 { path, size, sha256, content }。
// 依赖:L0 path-policy。导出:readTextFile。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { assertReadableWorkspacePath } from '../security/path-policy.js';

const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 256 * 1024;

export type ReadTextFileOptions = { root?: string; trustedRoot?: string; maxSize?: number };
export type ReadTextFileResult = { path: string; size: number; sha256: string; content: string };

function cappedMaxBytes(value: unknown, fallback = DEFAULT_MAX_BYTES): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), HARD_MAX_BYTES);
}

/**
 * 启发式判断是否疑似二进制:出现多个 NUL 或非常见控制字符即判定为二进制(拒读)。
 */
function isLikelyBinary(buffer: Buffer): boolean {
  let zeroCount = 0;
  for (const byte of buffer.values()) {
    if (byte === 0x00) {
      zeroCount += 1;
      if (zeroCount > 1) {
        return true;
      }
    }
    if (byte < 9) {
      return true;
    }
    if (byte > 13 && byte < 32) {
      return true;
    }
  }
  return false;
}

/**
 * 安全读取文本文件:校验路径与大小、拒绝二进制,返回内容与 sha256。
 */
export function readTextFile(filePath: string, options: ReadTextFileOptions = {}): ReadTextFileResult {
  const maxBytes = cappedMaxBytes(options.maxSize ?? DEFAULT_MAX_BYTES);
  const trustedRoot = options.trustedRoot ?? options.root;

  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }

  const safePath = assertReadableWorkspacePath(filePath, trustedRoot);
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) {
    throw new Error('Path is not a file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds max read size (${maxBytes} bytes)`);
  }

  const contentBuffer = fs.readFileSync(safePath);
  if (isLikelyBinary(contentBuffer)) {
    throw new Error('Binary file is blocked');
  }

  const sha256 = crypto.createHash('sha256').update(contentBuffer).digest('hex');
  return {
    path: safePath,
    size: stat.size,
    sha256,
    content: contentBuffer.toString('utf8'),
  };
}
