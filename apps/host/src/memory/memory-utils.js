// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  AUDIT_FILE,
  MAIN_MEMORY_FILE,
  MAX_FACT_KEY_LENGTH,
  MAX_FACT_VALUE_LENGTH,
  MEMORY_DIR_NAME,
  NOTES_DIR,
} from './memory-constants.js';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * @param {number} byte
 * @returns {string}
 */
function pickAlphabet(byte) {
  return ULID_ALPHABET[byte & 0x1f];
}

/**
 * @param {number} ms
 * @returns {string}
 */
function timestampPart(ms) {
  let value = BigInt(ms);
  const base = BigInt(32);
  const out = new Array(10);
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = ULID_ALPHABET[Number(value % base)];
    value /= base;
  }
  return out.join('');
}

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function ensureTrustedRoot(trustedRoot) {
  const root = String(trustedRoot || '').trim();
  if (!root) {
    throw new Error('trustedRoot is required');
  }
  return path.resolve(root);
}

/**
 * @param {string} dir
 * @returns {string}
 */
export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function memoryDir(trustedRoot) {
  return path.join(ensureTrustedRoot(trustedRoot), MEMORY_DIR_NAME);
}

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function notesDir(trustedRoot) {
  return path.join(memoryDir(trustedRoot), NOTES_DIR);
}

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function auditPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), AUDIT_FILE);
}

/**
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function mainMemoryPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), MAIN_MEMORY_FILE);
}

/**
 * @param {string} filePath
 * @param {string} body
 * @returns {string}
 */
export function safeWriteSync(filePath, body) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

/**
 * @param {unknown} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function clipUtf8(text, maxBytes) {
  if (!text) {
    return '';
  }
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= maxBytes) {
    return buffer.toString('utf8');
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.slice(0, end).toString('utf8');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function cleanFactKey(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error('memory fact key is required');
  }
  if (text.length > MAX_FACT_KEY_LENGTH) {
    throw new Error(`memory fact key too long; max ${MAX_FACT_KEY_LENGTH}`);
  }
  if (!/^[\w一-龥 .,:_/()\-]+$/u.test(text)) {
    throw new Error('memory fact key contains invalid characters');
  }
  return text;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function cleanFactValue(value) {
  const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
  if (!text) {
    throw new Error('memory fact value is required');
  }
  if (text.length > MAX_FACT_VALUE_LENGTH) {
    throw new Error(`memory fact value too long; max ${MAX_FACT_VALUE_LENGTH}`);
  }
  return text;
}

/**
 * @param {unknown} value
 * @returns {'project' | 'user' | 'session'}
 */
export function cleanScope(value) {
  const text = String(value || 'project').trim().toLowerCase();
  if (!['project', 'user', 'session'].includes(text)) {
    return 'project';
  }
  return /** @type {'project' | 'user' | 'session'} */ (text);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseTenantId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'tenant_local';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseUserId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'user_local';
}

/**
 * @param {string} prefix
 * @returns {string}
 */
export function memoryId(prefix) {
  const rand = crypto.randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `run_${timestampPart(Date.now())}${randomPart}`.replace(/^run_/, `${prefix}_`);
}
