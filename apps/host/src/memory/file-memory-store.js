// @ts-check
// 文件系统后端:主记忆与笔记的读写(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:在 <root>/.AgentCowork 下以 Markdown 文件实现记忆读写——读主记忆、列/读/写笔记、
//       追加事实行,并把构建 system 块/上下文委托给 memory-query;写操作经路径 jail
//       校验并产生审计事件。同时导出独立函数族与等价的 FileMemoryStore 类两种用法。
// 依赖:标准库(fs/path)、security/path-policy(路径边界)、同目录 memory-constants/
//       memory-audit/memory-utils/memory-query。
// 导出:readMainMemory / listMemoryNotes / readMemoryNote / writeMemoryNote /
//       appendMemoryFact / buildMemorySystemBlock / loadMemoryContext、FileMemoryStore 类。

import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import {
  MAX_MEMORY_BYTES,
  MEMORY_HEADER,
  NOTE_NAME_RE,
} from './memory-constants.js';
import { appendAuditEvent } from './memory-audit.js';
import {
  cleanFactKey,
  cleanFactValue,
  cleanScope,
  clipUtf8,
  ensureTrustedRoot,
  mainMemoryPath,
  notesDir,
  safeWriteSync,
} from './memory-utils.js';
import {
  buildMemorySystemBlockFromStore,
  loadMemoryContextFromStore,
} from './memory-query.js';

/**
 * @typedef {'project' | 'user' | 'session'} MemoryScope
 * @typedef {{ key?: unknown, value?: unknown, scope?: unknown }} MemoryFactInput
 * @typedef {{ key: string, value: string, scope: MemoryScope }} MemoryFact
 * @typedef {{ traceId?: unknown, tenantId?: unknown, userId?: unknown, idempotencyKey?: unknown, auditBus?: import('../storage/audit-events.js').AuditEventBus }} MemoryContext
 * @typedef {{ maxBytes?: number, context?: MemoryContext }} MemoryQueryOptions
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 */

/**
 * 读取主记忆文件全文;文件不存在时返回空串。
 * @param {unknown} trustedRoot
 * @returns {string}
 */
export function readMainMemory(trustedRoot) {
  const memoryFile = mainMemoryPath(trustedRoot);
  if (!fs.existsSync(memoryFile)) {
    return '';
  }
  return fs.readFileSync(memoryFile, 'utf8');
}

/**
 * 列出笔记目录下符合命名规则的笔记元信息(名/大小/修改时间/路径),按名排序。
 * @param {unknown} trustedRoot
 * @returns {MemoryNote[]}
 */
export function listMemoryNotes(trustedRoot) {
  const dir = notesDir(trustedRoot);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => NOTE_NAME_RE.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      return {
        name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        path: full,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 读取单条笔记正文;笔记名非法时抛错,文件不存在时返回 null。
 * @param {unknown} trustedRoot
 * @param {string} noteName
 * @returns {string | null}
 */
export function readMemoryNote(trustedRoot, noteName) {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  const file = path.join(notesDir(trustedRoot), noteName);
  if (!fs.existsSync(file)) {
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

/**
 * 写入单条笔记:校验笔记名、经路径 jail 确认落点在 root 内、按字节上限裁剪后写盘并发审计。
 * @param {unknown} trustedRoot
 * @param {string} noteName
 * @param {unknown} body
 * @param {MemoryContext} [context]
 * @returns {string}
 */
export function writeMemoryNote(trustedRoot, noteName, body, context = {}) {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  const root = ensureTrustedRoot(trustedRoot);
  const file = path.join(notesDir(root), noteName);
  assertTrustedPath(file, root);
  const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
  safeWriteSync(file, safeBody);
  appendAuditEvent(root, {
    action: 'memory_note_write',
    note: noteName,
    size: Buffer.byteLength(safeBody, 'utf8'),
    traceId: context.traceId,
    tenantId: context.tenantId,
    userId: context.userId,
  }, context);
  return file;
}

/**
 * 向主记忆追加一条事实行:清洗键/值/作用域,空文件先注入表头,保证以换行衔接,按上限裁剪后写盘并发审计。
 * @param {unknown} trustedRoot
 * @param {MemoryFactInput} fact
 * @param {MemoryContext} [context]
 * @returns {{ file: string, fact: MemoryFact }}
 */
export function appendMemoryFact(trustedRoot, fact, context = {}) {
  const root = ensureTrustedRoot(trustedRoot);
  const file = mainMemoryPath(root);
  assertTrustedPath(file, root);
  const key = cleanFactKey(fact?.key);
  const value = cleanFactValue(fact?.value);
  const scope = cleanScope(fact?.scope);
  const line = `- **${key}** (${scope}): ${value}\n`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seed = current
    ? current.endsWith('\n')
      ? current
      : `${current}\n`
    : MEMORY_HEADER;
  const next = clipUtf8(`${seed}${line}`, MAX_MEMORY_BYTES);
  safeWriteSync(file, next);
  appendAuditEvent(root, {
    action: 'memory_fact_append',
    key,
    scope,
    size: Buffer.byteLength(value, 'utf8'),
    traceId: context.traceId,
    tenantId: context.tenantId,
    userId: context.userId,
    idempotencyKey: context.idempotencyKey,
  }, context);
  return {
    file,
    fact: { key, value, scope },
  };
}

/**
 * 构建可注入的记忆 system 块(委托 memory-query,以本文件函数族为只读后端)。
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {string}
 */
export function buildMemorySystemBlock(trustedRoot, options = {}) {
  return buildMemorySystemBlockFromStore(fileMemoryApi, trustedRoot, options);
}

/**
 * 汇总记忆上下文(块文本 + 字节数 + 笔记列表,委托 memory-query)。
 * @param {unknown} trustedRoot
 * @param {MemoryQueryOptions} [options]
 * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
 */
export function loadMemoryContext(trustedRoot, options = {}) {
  return loadMemoryContextFromStore(fileMemoryApi, trustedRoot, options);
}

// 把本文件的只读函数打包成 SyncMemoryStoreLike,供 memory-query 复用而不必经过类实例。
/** @type {import('./memory-query.js').SyncMemoryStoreLike} */
const fileMemoryApi = {
  readMainMemory,
  listMemoryNotes,
  buildMemorySystemBlock,
};

/** 文件后端的类封装:把上面的独立函数族包成实例方法,实现与 SqliteMemoryStore 一致的接口。 */
export class FileMemoryStore {
  /** @param {unknown} trustedRoot @returns {string} */
  readMainMemory(trustedRoot) {
    return readMainMemory(trustedRoot);
  }

  /** @param {unknown} trustedRoot @returns {MemoryNote[]} */
  listMemoryNotes(trustedRoot) {
    return listMemoryNotes(trustedRoot);
  }

  /** @param {unknown} trustedRoot @param {string} noteName @returns {string | null} */
  readMemoryNote(trustedRoot, noteName) {
    return readMemoryNote(trustedRoot, noteName);
  }

  /** @param {unknown} trustedRoot @param {string} noteName @param {unknown} body @param {MemoryContext} [context] @returns {string} */
  writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    return writeMemoryNote(trustedRoot, noteName, body, context);
  }

  /** @param {unknown} trustedRoot @param {MemoryFactInput} fact @param {MemoryContext} [context] @returns {{ file: string, fact: MemoryFact }} */
  appendMemoryFact(trustedRoot, fact, context = {}) {
    return appendMemoryFact(trustedRoot, fact, context);
  }

  /** @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {string} */
  buildMemorySystemBlock(trustedRoot, options = {}) {
    return buildMemorySystemBlock(trustedRoot, options);
  }

  /** @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }} */
  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContext(trustedRoot, options);
  }
}
