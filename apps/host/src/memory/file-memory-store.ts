// 文件系统后端:主记忆与笔记的读写(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:在 <root>/.AgentCowork/owners/<owner-hash> 下以 Markdown 文件实现个人记忆读写——
//       读主记忆、列/读/写笔记、
//       追加事实行,并把构建 system 块/上下文委托给 memory-query;写操作经路径 jail
//       校验并产生审计事件。同时导出独立函数族与等价的 FileMemoryStore 类两种用法。
// 依赖:标准库(fs/path)、security/path-policy(路径边界)、同目录 memory-constants/
//       memory-audit/memory-utils/memory-query。
// 导出:readMainMemory / listMemoryNotes / readMemoryNote / writeMemoryNote /
//       appendMemoryFact / buildMemorySystemBlock / loadMemoryContext、FileMemoryStore 类。
import path from 'node:path';
import {
  MAX_MEMORY_BYTES,
  MEMORY_HEADER,
  NOTE_NAME_RE,
} from './memory-constants.js';
import { appendAuditEvent, type MemoryAuditContext } from './memory-audit.js';
import {
  beginMemoryFilesystemOperation,
  listManagedMemoryFiles,
  readManagedMemoryFile,
  writeManagedMemoryFile,
} from './memory-filesystem-boundary.js';
import {
  isLegacyLocalMemoryOwner,
  memoryOwnerMainPath,
  memoryOwnerNotesDir,
  requireMemoryOwner,
} from './memory-owner.js';
import {
  cleanFactKey,
  cleanFactValue,
  cleanScope,
  clipUtf8,
  mainMemoryPath,
  notesDir,
  type MemoryScope,
} from './memory-utils.js';
import {
  buildMemorySystemBlockFromStore,
  loadMemoryContextFromStore,
  type MemoryContextSummary,
  type MemoryNote,
  type MemoryQueryOptions,
  type SyncMemoryStoreLike,
} from './memory-query.js';

export type { MemoryScope, MemoryContextSummary, MemoryNote, MemoryQueryOptions };
export type MemoryFactInput = { key?: unknown; value?: unknown; scope?: unknown };
export type MemoryFact = { key: string; value: string; scope: MemoryScope };
export type MemoryContext = MemoryAuditContext & {
  traceId?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  idempotencyKey?: unknown;
};

export function readMainMemory(trustedRoot: unknown, _context: MemoryContext = {}): string {
  requireMemoryOwner(_context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const scoped = readManagedMemoryFile(
    operation,
    memoryOwnerMainPath(operation.root, _context),
  );
  if (scoped.exists) return scoped.body;
  return isLegacyLocalMemoryOwner(_context)
    ? readManagedMemoryFile(operation, mainMemoryPath(operation.root)).body
    : '';
}

export function listMemoryNotes(trustedRoot: unknown, _context: MemoryContext = {}): MemoryNote[] {
  requireMemoryOwner(_context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const dirs = [memoryOwnerNotesDir(operation.root, _context)];
  if (isLegacyLocalMemoryOwner(_context)) dirs.push(notesDir(operation.root));
  const byName = new Map<string, MemoryNote>();
  for (const dir of dirs) {
    for (const entry of listManagedMemoryFiles(operation, dir, (name) => NOTE_NAME_RE.test(name))) {
      const { name } = entry;
      if (byName.has(name)) continue;
      byName.set(name, {
        name,
        size: entry.stats.size,
        modifiedAt: entry.stats.mtime.toISOString(),
        path: entry.path,
      });
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function readMemoryNote(trustedRoot: unknown, noteName: string, _context: MemoryContext = {}): string | null {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  requireMemoryOwner(_context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const scoped = readManagedMemoryFile(
    operation,
    path.join(memoryOwnerNotesDir(operation.root, _context), noteName),
  );
  if (scoped.exists) return scoped.body;
  if (!isLegacyLocalMemoryOwner(_context)) return null;
  const legacy = readManagedMemoryFile(
    operation,
    path.join(notesDir(operation.root), noteName),
  );
  return legacy.exists ? legacy.body : null;
}

export function writeMemoryNote(
  trustedRoot: unknown,
  noteName: string,
  body: unknown,
  context: MemoryContext = {},
): string {
  if (!NOTE_NAME_RE.test(String(noteName || ''))) {
    throw new Error('Invalid memory note name');
  }
  requireMemoryOwner(context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const root = operation.root;
  const file = path.join(memoryOwnerNotesDir(root, context), noteName);
  const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
  writeManagedMemoryFile(operation, file, safeBody);
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

export function appendMemoryFact(
  trustedRoot: unknown,
  fact: MemoryFactInput,
  context: MemoryContext = {},
): { file: string; fact: MemoryFact } {
  requireMemoryOwner(context);
  const operation = beginMemoryFilesystemOperation(trustedRoot);
  const root = operation.root;
  const file = memoryOwnerMainPath(root, context);
  const key = cleanFactKey(fact?.key);
  const value = cleanFactValue(fact?.value);
  const scope = cleanScope(fact?.scope);
  const line = `- **${key}** (${scope}): ${value}\n`;
  const scoped = readManagedMemoryFile(operation, file);
  const current = scoped.exists
    ? scoped.body
    : isLegacyLocalMemoryOwner(context)
      ? readManagedMemoryFile(operation, mainMemoryPath(root)).body
      : '';
  const seed = current
    ? current.endsWith('\n')
      ? current
      : `${current}\n`
    : MEMORY_HEADER;
  const next = clipUtf8(`${seed}${line}`, MAX_MEMORY_BYTES);
  writeManagedMemoryFile(operation, file, next);
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

export function buildMemorySystemBlock(trustedRoot: unknown, options: MemoryQueryOptions = {}): string {
  return buildMemorySystemBlockFromStore(fileMemoryApi, trustedRoot, options);
}

export function loadMemoryContext(trustedRoot: unknown, options: MemoryQueryOptions = {}): MemoryContextSummary {
  return loadMemoryContextFromStore(fileMemoryApi, trustedRoot, options);
}

// 把本文件的只读函数打包成 SyncMemoryStoreLike,供 memory-query 复用而不必经过类实例。
const fileMemoryApi: SyncMemoryStoreLike = {
  readMainMemory,
  listMemoryNotes,
  buildMemorySystemBlock,
};

/** 文件后端的类封装:把上面的独立函数族包成实例方法,实现与 SqliteMemoryStore 一致的接口。 */
export class FileMemoryStore {
  readMainMemory(trustedRoot: unknown, context: MemoryContext = {}): string {
    return readMainMemory(trustedRoot, context);
  }

  listMemoryNotes(trustedRoot: unknown, context: MemoryContext = {}): MemoryNote[] {
    return listMemoryNotes(trustedRoot, context);
  }

  readMemoryNote(trustedRoot: unknown, noteName: string, context: MemoryContext = {}): string | null {
    return readMemoryNote(trustedRoot, noteName, context);
  }

  writeMemoryNote(trustedRoot: unknown, noteName: string, body: unknown, context: MemoryContext = {}): string {
    return writeMemoryNote(trustedRoot, noteName, body, context);
  }

  appendMemoryFact(
    trustedRoot: unknown,
    fact: MemoryFactInput,
    context: MemoryContext = {},
  ): { file: string; fact: MemoryFact } {
    return appendMemoryFact(trustedRoot, fact, context);
  }

  buildMemorySystemBlock(trustedRoot: unknown, options: MemoryQueryOptions = {}): string {
    return buildMemorySystemBlock(trustedRoot, options);
  }

  loadMemoryContext(trustedRoot: unknown, options: MemoryQueryOptions = {}): MemoryContextSummary {
    return loadMemoryContext(trustedRoot, options);
  }
}
