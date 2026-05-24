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

export class SqliteMemoryStore {
  constructor({ dbPath, db = null, now = () => new Date() } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteMemoryStore: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath);
    this.now = now;
  }

  readMainMemory(trustedRoot, context = {}) {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = this.db.prepare(`
      SELECT fact_json
      FROM memory_facts
      WHERE tenant_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(tenantId);
    if (!rows.length) {
      return '';
    }
    const lines = rows.map((row) => {
      const fact = JSON.parse(row.fact_json);
      return `- **${fact.key}** (${fact.scope}): ${fact.value}\n`;
    });
    return clipUtf8(`${MEMORY_HEADER}${lines.join('')}`, MAX_MEMORY_BYTES);
  }

  listMemoryNotes(trustedRoot, context = {}) {
    ensureTrustedRoot(trustedRoot);
    const tenantId = normaliseTenantId(context.tenantId);
    const rows = this.db.prepare(`
      SELECT id, name, size, created_at, updated_at
      FROM memory_notes
      WHERE tenant_id = ?
      ORDER BY name ASC
    `).all(tenantId);
    return rows.map((row) => ({
      name: row.name,
      size: Number(row.size) || 0,
      modifiedAt: row.updated_at || row.created_at,
      path: `sqlite://memory_notes/${row.id}`,
    }));
  }

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
    return row ? row.body : null;
  }

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
    const id = existing?.id || memoryId('memnote');
    const now = this.now().toISOString();
    const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
    const note = {
      id,
      name: noteName,
      size: Buffer.byteLength(safeBody, 'utf8'),
      createdAt: existing?.created_at || now,
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

  buildMemorySystemBlock(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const main = this.readMainMemory(trustedRoot, context);
    return buildMemorySystemBlockFromText(main, { maxBytes });
  }

  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContextFromStore(this, trustedRoot, options);
  }
}
