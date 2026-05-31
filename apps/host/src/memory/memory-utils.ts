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
export type MemoryScope = 'project' | 'user' | 'session';

function pickAlphabet(byte: number): string {
  return ULID_ALPHABET[byte & 0x1f];
}

function timestampPart(ms: number): string {
  let value = BigInt(ms);
  const base = BigInt(32);
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = ULID_ALPHABET[Number(value % base)];
    value /= base;
  }
  return out.join('');
}

/**
 * 校验并规范 trustedRoot:空值抛错,否则解析为绝对路径(后续路径推导的根)。
 */
export function ensureTrustedRoot(trustedRoot: unknown): string {
  const root = String(trustedRoot || '').trim();
  if (!root) {
    throw new Error('trustedRoot is required');
  }
  return path.resolve(root);
}

/**
 * 递归创建目录(已存在则幂等),返回该目录路径。
 */
export function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 推导记忆根目录 <root>/.AgentCowork。
 */
export function memoryDir(trustedRoot: unknown): string {
  return path.join(ensureTrustedRoot(trustedRoot), MEMORY_DIR_NAME);
}

/**
 * 推导笔记子目录(记忆根目录下的 NOTES_DIR)。
 */
export function notesDir(trustedRoot: unknown): string {
  return path.join(memoryDir(trustedRoot), NOTES_DIR);
}

/**
 * 推导审计文件路径(记忆根目录下的 AUDIT_FILE)。
 */
export function auditPath(trustedRoot: unknown): string {
  return path.join(memoryDir(trustedRoot), AUDIT_FILE);
}

/**
 * 推导主记忆文件路径(记忆根目录下的 MAIN_MEMORY_FILE)。
 */
export function mainMemoryPath(trustedRoot: unknown): string {
  return path.join(memoryDir(trustedRoot), MAIN_MEMORY_FILE);
}

/**
 * 写文件并确保父目录存在(先 mkdir 再 writeFile),返回写入路径。
 */
export function safeWriteSync(filePath: string, body: string): string {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

/**
 * 按字节上限安全截断 UTF-8 文本:回退到字符边界,避免把多字节字符切成乱码。
 */
export function clipUtf8(text: unknown, maxBytes: number): string {
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
 */
export function cleanFactKey(value: unknown): string {
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
 */
export function cleanFactValue(value: unknown): string {
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
 */
export function cleanScope(value: unknown): MemoryScope {
  const text = String(value || 'project').trim().toLowerCase();
  if (!['project', 'user', 'session'].includes(text)) {
    return 'project';
  }
  return text as MemoryScope;
}

/**
 * 归一化租户 ID:去空白、限 96 字符,缺省回落到 'tenant_local'。
 */
export function normaliseTenantId(value: unknown): string {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'tenant_local';
}

/**
 * 归一化用户 ID:去空白、限 96 字符,缺省回落到 'user_local'。
 */
export function normaliseUserId(value: unknown): string {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'user_local';
}

/**
 * 生成带前缀的 ULID 风格 ID(时间戳部分 + 随机部分),用于 sqlite 后端的笔记/事实主键。
 */
export function memoryId(prefix: string): string {
  const rand = crypto.randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `run_${timestampPart(Date.now())}${randomPart}`.replace(/^run_/, `${prefix}_`);
}
