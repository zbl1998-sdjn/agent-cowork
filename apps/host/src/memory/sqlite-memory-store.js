// @ts-check
// SQLite 后端:用数据库表实现记忆读写(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:以 memory_facts / memory_notes 两张表替代文件存储,按 tenant 隔离做事实追加与
//       笔记 upsert(冲突按 tenant_id+name 更新),读主记忆时把事实行重组为 Markdown,
//       构建 system 块/上下文委托 memory-query;写操作产生与文件后端一致的审计事件。
//       接口与 FileMemoryStore 等价,二者经 createMemoryStore 互换。
// 依赖:storage/sqlite(数据库句柄)、同目录 memory-constants/memory-audit/
//       memory-query/memory-utils。
// 导出:SqliteMemoryStore 类。

import { createSqliteDatabase } from '../storage/sqlite.js';
import { MAX_MEMORY_BYTES, MEMORY_HEADER, NOTE_NAME_RE } from './memory-constants.js';
import { appendAuditEvent } from './memory-audit.js';
import { buildMemorySystemBlockFromText, loadMemoryContextFromStore } from './memory-query.js';
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

/**
 * @typedef {'project' | 'user' | 'session'} MemoryScope
 * @typedef {{ key?: unknown, value?: unknown, scope?: unknown }} MemoryFactInput
 * @typedef {{ key: string, value: string, scope: MemoryScope }} MemoryFact
 * @typedef {{ traceId?: unknown, tenantId?: unknown, userId?: unknown, idempotencyKey?: unknown, auditBus?: import('../storage/audit-events.js').AuditEventBus }} MemoryContext
 * @typedef {{ maxBytes?: number, context?: MemoryContext }} MemoryQueryOptions
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 * @typedef {{ fact_json: string }} MemoryFactRow
 * @typedef {{ id: string, name: string, size: number, created_at: string, updated_at: string }} MemoryNoteRow
 * @typedef {{ body: string }} MemoryNoteBodyRow
 * @typedef {{ id: string, created_at: string }} MemoryExistingNoteRow
 */

/** SQLite 后端实现,接口对齐 FileMemoryStore;事实/笔记落库并按租户隔离。 */
export class SqliteMemoryStore {
  /**
   * 构造:复用传入的 db 句柄,或据 dbPath 新建;db 与 dbPath 均缺失则抛错。
   * @param {{ dbPath?: string, db?: import('../storage/sqlite.js').SqliteDatabase | null, now?: () => Date }} [options]
   */
  constructor({ dbPath, db = null, now = () => new Date() } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteMemoryStore: dbPath is required');
    }
    /** @type {import('../storage/sqlite.js').SqliteDatabase} */
    this.db = db || createSqliteDatabase(/** @type {string} */ (dbPath));
    /** @type {() => Date} */
    this.now = now;
  }

  /**
   * 读主记忆:按租户取全部事实(按创建/ID 排序),重组为 Markdown 表头 + 事实行并按上限裁剪;无事实返回空串。
   * @param {unknown} trustedRoot
   * @param {MemoryContext} [context]
   * @returns {string}
   */
  readMainMemory(trustedRoot, context = {}) {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = /** @type {MemoryFactRow[]} */ (this.db.prepare(`
      SELECT fact_json
      FROM memory_facts
      WHERE tenant_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(tenantId));
    if (!rows.length) {
      return '';
    }
    const lines = rows.map((row) => {
      const fact = /** @type {MemoryFact} */ (JSON.parse(row.fact_json));
      return `- **${fact.key}** (${fact.scope}): ${fact.value}\n`;
    });
    return clipUtf8(`${MEMORY_HEADER}${lines.join('')}`, MAX_MEMORY_BYTES);
  }

  /**
   * 列出某租户的笔记元信息(path 用 sqlite:// 伪路径表示),按名排序。
   * @param {unknown} trustedRoot
   * @param {MemoryContext} [context]
   * @returns {MemoryNote[]}
   */
  listMemoryNotes(trustedRoot, context = {}) {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = /** @type {MemoryNoteRow[]} */ (this.db.prepare(`
      SELECT id, name, size, created_at, updated_at
      FROM memory_notes
      WHERE tenant_id = ?
      ORDER BY name ASC
    `).all(tenantId));
    return rows.map((row) => ({
      name: row.name,
      size: Number(row.size) || 0,
      modifiedAt: row.updated_at || row.created_at,
      path: `sqlite://memory_notes/${row.id}`,
    }));
  }

  /**
   * 按租户 + 笔记名读取正文;名非法抛错,无记录返回 null。
   * @param {unknown} trustedRoot
   * @param {string} noteName
   * @param {MemoryContext} [context]
   * @returns {string | null}
   */
  readMemoryNote(trustedRoot, noteName, context = {}) {
    ensureTrustedRoot(trustedRoot);
    if (!NOTE_NAME_RE.test(String(noteName || ''))) {
      throw new Error('Invalid memory note name');
    }
    const tenantId = normaliseTenantId(context.tenantId);
    const row = this.db.prepare(`
      SELECT body
      FROM memory_notes
      WHERE tenant_id = ? AND name = ?
    `).get(tenantId, noteName);
    return row ? (/** @type {MemoryNoteBodyRow} */ (row)).body : null;
  }

  /**
   * 写笔记:upsert(按 tenant_id+name 冲突更新),复用既有 id 与 created_at 以保留首次创建时间,裁剪正文后发审计。
   * @param {unknown} trustedRoot
   * @param {string} noteName
   * @param {unknown} body
   * @param {MemoryContext} [context]
   * @returns {string}
   */
  writeMemoryNote(trustedRoot, noteName, body, context = {}) {
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
    const existingRow = /** @type {MemoryExistingNoteRow | null} */ (existing || null);
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

  /**
   * 追加事实:清洗键/值/作用域,生成 ID 后 INSERT 一行(不更新历史,纯追加),并发审计。
   * @param {unknown} trustedRoot
   * @param {MemoryFactInput} fact
   * @param {MemoryContext} [context]
   * @returns {{ file: string, fact: MemoryFact }}
   */
  appendMemoryFact(trustedRoot, fact, context = {}) {
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

  /**
   * 构建记忆 system 块:先重组主记忆文本,再交给 memory-query 裁剪。
   * @param {unknown} trustedRoot
   * @param {MemoryQueryOptions} [options]
   * @returns {string}
   */
  buildMemorySystemBlock(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const main = this.readMainMemory(trustedRoot, context);
    return buildMemorySystemBlockFromText(main, { maxBytes });
  }

  /**
   * 汇总记忆上下文(委托 memory-query,以本实例为后端)。
   * @param {unknown} trustedRoot
   * @param {MemoryQueryOptions} [options]
   * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
   */
  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContextFromStore(this, trustedRoot, options);
  }
}
