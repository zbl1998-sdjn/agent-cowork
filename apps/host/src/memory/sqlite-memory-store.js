// @ts-check

import { createSqliteDatabase } from '../storage/sqlite.js';
import {
  MAX_MEMORY_BYTES,
  MEMORY_HEADER,
  NOTE_NAME_RE,
} from './memory-constants.js';
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

export class SqliteMemoryStore {
  /**
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
   * @param {unknown} trustedRoot
   * @param {MemoryQueryOptions} [options]
   * @returns {string}
   */
  buildMemorySystemBlock(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const main = this.readMainMemory(trustedRoot, context);
    return buildMemorySystemBlockFromText(main, { maxBytes });
  }

  /**
   * @param {unknown} trustedRoot
   * @param {MemoryQueryOptions} [options]
   * @returns {{ enabled: boolean, bytes: number, text: string, notes: MemoryNote[] }}
   */
  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContextFromStore(this, trustedRoot, options);
  }
}
