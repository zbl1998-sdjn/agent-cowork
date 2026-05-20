import fs from 'node:fs';
import crypto from 'node:crypto';
import { assertTrustedPath } from '../security/path-policy.js';

const DEFAULT_MAX_BYTES = 256 * 1024;

function isLikelyBinary(buffer) {
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

export function readTextFile(filePath, options = {}) {
  const maxBytes = Number(options.maxSize ?? DEFAULT_MAX_BYTES);
  const trustedRoot = options.trustedRoot ?? options.root;

  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }

  const safePath = assertTrustedPath(filePath, trustedRoot);
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
