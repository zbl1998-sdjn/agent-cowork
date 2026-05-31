// SQLite 后端:用数据库表实现记忆读写(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:以 memory_facts / memory_notes 两张表替代文件存储,按 tenant 隔离做事实追加与
//       笔记 upsert(冲突按 tenant_id+name 更新),读主记忆时把事实行重组为 Markdown,
//       构建 system 块/上下文委托 memory-query;写操作产生与文件后端一致的审计事件。
//       接口与 FileMemoryStore 等价,二者经 createMemoryStore 互换。
// 依赖:storage/sqlite(数据库句柄)、同目录 memory-constants/memory-audit/
//       memory-query/memory-utils。
// 导出:SqliteMemoryStore 类。
import { createSqliteDatabase, type SqliteDatabase } from '../storage/sqlite.js';
import { MAX_MEMORY_BYTES, MEMORY_HEADER, NOTE_NAME_RE } from './memory-constants.js';
import { appendAuditEvent } from './memory-audit.js';
import { buildMemorySystemBlockFromText, loadMemoryContextFromStore, type MemoryContextSummary } from './memory-query.js';
import {
  cleanFactKey,
  cleanFactValue,
  cleanScope,
  clipUtf8,
  ensureTrustedRoot,
  memoryId,
  normaliseTenantId,
  normaliseUserId,
} from './memory-utils.js';
import type { MemoryContext, MemoryFact, MemoryFactInput, MemoryNote, MemoryQueryOptions } from './file-memory-store.js';

export type SqliteMemoryStoreOptions = { dbPath?: string; db?: SqliteDatabase | null; now?: () => Date };
type MemoryFactRow = { fact_json: string };
type MemoryNoteRow = { id: string; name: string; size: number; created_at: string; updated_at: string };
type MemoryNoteBodyRow = { body: string };
type MemoryExistingNoteRow = { id: string; created_at: string };

/** SQLite 后端实现,接口对齐 FileMemoryStore;事实/笔记落库并按租户隔离。 */
export class SqliteMemoryStore {
  readonly db: SqliteDatabase;
  readonly now: () => Date;

  constructor({ dbPath, db = null, now = () => new Date() }: SqliteMemoryStoreOptions = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteMemoryStore: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath as string);
    this.now = now;
  }

  readMainMemory(trustedRoot: unknown, context: MemoryContext = {}): string {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = this.db.prepare(`
      SELECT fact_json
      FROM memory_facts
      WHERE tenant_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(tenantId) as MemoryFactRow[];
    if (!rows.length) {
      return '';
    }
    const lines = rows.map((row) => {
      const fact = JSON.parse(row.fact_json) as MemoryFact;
      return `- **${fact.key}** (${fact.scope}): ${fact.value}\n`;
    });
    return clipUtf8(`${MEMORY_HEADER}${lines.join('')}`, MAX_MEMORY_BYTES);
  }

  listMemoryNotes(trustedRoot: unknown, context: MemoryContext = {}): MemoryNote[] {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = this.db.prepare(`
      SELECT id, name, size, created_at, updated_at
      FROM memory_notes
      WHERE tenant_id = ?
      ORDER BY name ASC
    `).all(tenantId) as MemoryNoteRow[];
    return rows.map((row) => ({
      name: row.name,
      size: Number(row.size) || 0,
      modifiedAt: row.updated_at || row.created_at,
      path: `sqlite://memory_notes/${row.id}`,
    }));
  }

  readMemoryNote(trustedRoot: unknown, noteName: string, context: MemoryContext = {}): string | null {
    ensureTrustedRoot(trustedRoot);
    if (!NOTE_NAME_RE.test(String(noteName || ''))) {
      throw new Error('Invalid memory note name');
    }
    const tenantId = normaliseTenantId(context.tenantId);
    const row = this.db.prepare(`
      SELECT body
      FROM memory_notes
      WHERE tenant_id = ? AND name = ?
    `).get(tenantId, noteName) as MemoryNoteBodyRow | null | undefined;
    return row ? row.body : null;
  }

  writeMemoryNote(trustedRoot: unknown, noteName: string, body: unknown, context: MemoryContext = {}): string {
    const root = ensureTrustedRoot(trustedRoot);
    if (!NOTE_NAME_RE.test(String(noteName || ''))) {
      throw new Error('Invalid memory note name');
    }
    const tenantId = normaliseTenantId(context.tenantId);
    const userId = normaliseUserId(context.userId);
    const existing = this.db.prepare(`
      SELECT id, created_at
      FROM memory_notes
      WHERE tenant_id = ? AND name = ?
    `).get(tenantId, noteName);
    const existingRow = existing as MemoryExistingNoteRow | null;
    const id = existingRow?.id || memoryId('memnote');
    const now = this.now().toISOString();
    const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
    const note = {
      id,
      name: noteName,
      size: Buffer.byteLength(safeBody, 'utf8'),
      createdAt: existingRow?.created_at || now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO memory_notes (
        id, tenant_id, user_id, trace_id, name, body, size,
        created_at, updated_at, note_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, name) DO UPDATE SET
        user_id = excluded.user_id,
        trace_id = excluded.trace_id,
        body = excluded.body,
        size = excluded.size,
        updated_at = excluded.updated_at,
        note_json = excluded.note_json
    `).run(
      id, tenantId, userId, context.traceId || null, noteName, safeBody,
      note.size, note.createdAt, note.updatedAt, JSON.stringify(note),
    );
    appendAuditEvent(root, {
      action: 'memory_note_write',
      note: noteName,
      size: note.size,
      traceId: context.traceId,
      tenantId: context.tenantId,
      userId: context.userId,
      idempotencyKey: context.idempotencyKey,
    }, context);
    return `sqlite://memory_notes/${id}`;
  }

  appendMemoryFact(
    trustedRoot: unknown,
    fact: MemoryFactInput,
    context: MemoryContext = {},
  ): { file: string; fact: MemoryFact } {
    const root = ensureTrustedRoot(trustedRoot);
    const key = cleanFactKey(fact?.key);
    const value = cleanFactValue(fact?.value);
    const scope = cleanScope(fact?.scope);
    const tenantId = normaliseTenantId(context.tenantId);
    const userId = normaliseUserId(context.userId);
    const id = memoryId('memfact');
    const now = this.now().toISOString();
    const storedFact = { id, key, value, scope, createdAt: now };
    this.db.prepare(`
      INSERT INTO memory_facts (
        id, tenant_id, user_id, trace_id, key, value, scope,
        created_at, updated_at, fact_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, tenantId, userId, context.traceId || null, key, value,
      scope, now, now, JSON.stringify(storedFact),
    );
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
      file: `sqlite://memory_facts/${id}`,
      fact: { key, value, scope },
    };
  }

  buildMemorySystemBlock(trustedRoot: unknown, { maxBytes = 4096, context = {} }: MemoryQueryOptions = {}): string {
    const main = this.readMainMemory(trustedRoot, context as MemoryContext);
    return buildMemorySystemBlockFromText(main, { maxBytes });
  }

  loadMemoryContext(trustedRoot: unknown, options: MemoryQueryOptions = {}): MemoryContextSummary {
    return loadMemoryContextFromStore(this, trustedRoot, options);
  }
}
