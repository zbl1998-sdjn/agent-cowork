import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { createUlid } from '../runtime/runs-index.js';
import { createSqliteDatabase } from '../storage/sqlite.js';
import { AuditEventBus, createJsonlAuditSubscriber } from '../runtime/audit-events.js';

const MEMORY_DIR_NAME = '.KimiCowork';
const MAIN_MEMORY_FILE = 'MEMORY.md';
const NOTES_DIR = 'memory';
const AUDIT_FILE = path.join('audit', 'memory.jsonl');
const MEMORY_HEADER = '# Kimi Cowork 项目记忆\n\n这份文件记录 Kimi 在本工作区需要长期记住的事实。每次对话开始时被注入到 system 段。\n\n';

const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_FACT_KEY_LENGTH = 96;
const MAX_FACT_VALUE_LENGTH = 4 * 1024;
const NOTE_NAME_RE = /^[a-z0-9_.-]{1,96}\.md$/i;
const defaultAuditBuses = new Map();

function ensureTrustedRoot(trustedRoot) {
  const root = String(trustedRoot || '').trim();
  if (!root) {
    throw new Error('trustedRoot is required');
  }
  return path.resolve(root);
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function memoryDir(trustedRoot) {
  return path.join(ensureTrustedRoot(trustedRoot), MEMORY_DIR_NAME);
}

function notesDir(trustedRoot) {
  return path.join(memoryDir(trustedRoot), NOTES_DIR);
}

function auditPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), AUDIT_FILE);
}

function mainMemoryPath(trustedRoot) {
  return path.join(memoryDir(trustedRoot), MAIN_MEMORY_FILE);
}

function safeWriteSync(filePath, body) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
  return filePath;
}

function getDefaultAuditBus(trustedRoot) {
  const audit = auditPath(trustedRoot);
  let bus = defaultAuditBuses.get(audit);
  if (!bus) {
    bus = new AuditEventBus();
    bus.subscribe(createJsonlAuditSubscriber(audit));
    defaultAuditBuses.set(audit, bus);
  }
  return bus;
}

function appendAuditEvent(trustedRoot, event, context = {}) {
  const audit = auditPath(trustedRoot);
  const bus = context.auditBus || getDefaultAuditBus(trustedRoot);
  bus.publish(event);
  return audit;
}

function clipUtf8(text, maxBytes) {
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

function cleanFactKey(value) {
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

function cleanFactValue(value) {
  const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
  if (!text) {
    throw new Error('memory fact value is required');
  }
  if (text.length > MAX_FACT_VALUE_LENGTH) {
    throw new Error(`memory fact value too long; max ${MAX_FACT_VALUE_LENGTH}`);
  }
  return text;
}

function cleanScope(value) {
  const text = String(value || 'project').trim().toLowerCase();
  if (!['project', 'user', 'session'].includes(text)) {
    return 'project';
  }
  return text;
}

function normaliseTenantId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'tenant_local';
}

function normaliseUserId(value) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 96) : 'user_local';
}

function memoryId(prefix) {
  return createUlid().replace(/^run_/, `${prefix}_`);
}

export function readMainMemory(trustedRoot) {
  const memoryFile = mainMemoryPath(trustedRoot);
  if (!fs.existsSync(memoryFile)) {
    return '';
  }
  return fs.readFileSync(memoryFile, 'utf8');
}

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

export function buildMemorySystemBlock(trustedRoot, { maxBytes = 4096 } = {}) {
  try {
    const main = readMainMemory(trustedRoot);
    if (!main.trim()) {
      return '';
    }
    const clipped = clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes)));
    return clipped.trim();
  } catch {
    return '';
  }
}

export function loadMemoryContext(trustedRoot, { maxBytes = 4096 } = {}) {
  const block = buildMemorySystemBlock(trustedRoot, { maxBytes });
  const notes = listMemoryNotes(trustedRoot).map((note) => ({
    name: note.name,
    size: note.size,
    modifiedAt: note.modifiedAt,
  }));
  return {
    enabled: Boolean(block),
    bytes: Buffer.byteLength(block, 'utf8'),
    text: block,
    notes,
  };
}

export const MEMORY_LIMITS = Object.freeze({
  maxMemoryBytes: MAX_MEMORY_BYTES,
  maxFactKeyLength: MAX_FACT_KEY_LENGTH,
  maxFactValueLength: MAX_FACT_VALUE_LENGTH,
});

export class FileMemoryStore {
  readMainMemory(trustedRoot) {
    return readMainMemory(trustedRoot);
  }

  listMemoryNotes(trustedRoot) {
    return listMemoryNotes(trustedRoot);
  }

  readMemoryNote(trustedRoot, noteName) {
    return readMemoryNote(trustedRoot, noteName);
  }

  writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    return writeMemoryNote(trustedRoot, noteName, body, context);
  }

  appendMemoryFact(trustedRoot, fact, context = {}) {
    return appendMemoryFact(trustedRoot, fact, context);
  }

  buildMemorySystemBlock(trustedRoot, options = {}) {
    return buildMemorySystemBlock(trustedRoot, options);
  }

  loadMemoryContext(trustedRoot, options = {}) {
    return loadMemoryContext(trustedRoot, options);
  }
}

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
      id,
      tenantId,
      userId,
      context.traceId || null,
      noteName,
      safeBody,
      note.size,
      note.createdAt,
      note.updatedAt,
      JSON.stringify(note),
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
      id,
      tenantId,
      userId,
      context.traceId || null,
      key,
      value,
      scope,
      now,
      now,
      JSON.stringify(storedFact),
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
    if (!main.trim()) {
      return '';
    }
    const clipped = clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes)));
    return clipped.trim();
  }

  loadMemoryContext(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const block = this.buildMemorySystemBlock(trustedRoot, { maxBytes, context });
    const notes = this.listMemoryNotes(trustedRoot, context).map((note) => ({
      name: note.name,
      size: note.size,
      modifiedAt: note.modifiedAt,
    }));
    return {
      enabled: Boolean(block),
      bytes: Buffer.byteLength(block, 'utf8'),
      text: block,
      notes,
    };
  }
}

export function createMemoryStore({ backend = 'file', dbPath, db, now } = {}) {
  if (backend === 'sqlite') {
    return new SqliteMemoryStore({ dbPath, db, now });
  }
  return new FileMemoryStore();
}

export async function flushMemoryAuditEvents(trustedRoot) {
  const bus = defaultAuditBuses.get(auditPath(trustedRoot));
  if (bus) {
    await bus.flush();
  }
}
