// @ts-check
// 记忆层的纯工具函数(路径/校验/裁剪/ID)(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:为 file/sqlite 后端提供无状态辅助:解析 trustedRoot、推导各记忆/笔记/审计路径、
//       UTF-8 安全字节截断、事实键值与 scope/租户/用户的清洗归一化、ULID 风格 ID 生成。
// 依赖:仅标准库(node:fs / node:path / node:crypto)、同目录 memory-constants(上限)。
// 导出:ensureTrustedRoot / ensureDirSync / memoryDir / notesDir / auditPath /
//       mainMemoryPath / safeWriteSync / clipUtf8 / cleanFactKey / cleanFactValue /
//       cleanScope / normaliseTenantId / normaliseUserId / memoryId。

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
 * 校验并规范 trustedRoot:空值抛错,否则解析为绝对路径(后续路径推导的根)。
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
 * 递归创建目录(已存在则幂等),返回该目录路径。
 * @param {string} dir
 * @returns {string}
 */
export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 推导记忆根目录 <root>/.AgentCowork。
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function memoryDir(trustedRoot) {
  return path.join(ensureTrustedRoot(trustedRoot), MEMORY_DIR_NAME);
}

/**
 * 推导笔记子目录(记忆根目录下的 NOTES_DIR)。
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function notesDir(trustedRoot) {
  return path.join(memoryDir(trustedRoot), NOTES_DIR);
}

/**
 * 推导审计文件路径(记忆根目录下的 AUDIT_FILE)。
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function auditPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), AUDIT_FILE);
}

/**
 * 推导主记忆文件路径(记忆根目录下的 MAIN_MEMORY_FILE)。
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function mainMemoryPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), MAIN_MEMORY_FILE);
}

/**
 * 写文件并确保父目录存在(先 mkdir 再 writeFile),返回写入路径。
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
 * 按字节上限安全截断 UTF-8 文本:回退到字符边界,避免把多字节字符切成乱码。
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
 * 校验并清洗事实键:去空白、限长、仅允许字母数字与中文及少量标点(防注入异常字符)。
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
 * 校验并清洗事实值:统一换行为 \n、去首尾空白、限长(空值或超长抛错)。
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
 * 归一化作用域:只接受 project/user/session,非法值一律回落到 project。
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
 * 归一化租户 ID:去空白、限 96 字符,缺省回落到 'tenant_local'。
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseTenantId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'tenant_local';
}

/**
 * 归一化用户 ID:去空白、限 96 字符,缺省回落到 'user_local'。
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseUserId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'user_local';
}

/**
 * 生成带前缀的 ULID 风格 ID(时间戳部分 + 随机部分),用于 sqlite 后端的笔记/事实主键。
 * @param {string} prefix
 * @returns {string}
 */
export function memoryId(prefix) {
  const rand = crypto.randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `run_${timestampPart(Date.now())}${randomPart}`.replace(/^run_/, `${prefix}_`);
}
