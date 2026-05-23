// PostgreSQL adapter for cross-session memory (facts + notes) — multi-instance
// mirror of SqliteMemoryStore. Async; `pg` lazily/optionally imported. Tenant
// -scoped. Tests inject a mock pool.
import crypto from 'node:crypto';

const MEMORY_HEADER = '# Agent Cowork 项目记忆\n\n这份文件记录 Kimi 在本工作区需要长期记住的事实。每次对话开始时被注入到 system 段。\n\n';
const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_FACT_KEY_LENGTH = 96;
const MAX_FACT_VALUE_LENGTH = 4 * 1024;
const NOTE_NAME_RE = /^[a-z0-9_.-]{1,96}\.md$/i;

function clampId(v, fb) { const t = String(v || '').trim(); return t ? (t.length > 96 ? t.slice(0, 96) : t) : fb; }
const normTenant = (v) => clampId(v, 'tenant_local');
const normUser = (v) => clampId(v, 'user_local');
function memId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; }

function clipUtf8(text, maxBytes) {
  if (!text) return '';
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString('utf8');
}
function cleanFactKey(v) {
  const t = String(v || '').trim();
  if (!t) throw new Error('memory fact key is required');
  if (t.length > MAX_FACT_KEY_LENGTH) throw new Error(`memory fact key too long; max ${MAX_FACT_KEY_LENGTH}`);
  if (!/^[\w一-龥 .,:_/()\-]+$/u.test(t)) throw new Error('memory fact key contains invalid characters');
  return t;
}
function cleanFactValue(v) {
  const t = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  if (!t) throw new Error('memory fact value is required');
  if (t.length > MAX_FACT_VALUE_LENGTH) throw new Error(`memory fact value too long; max ${MAX_FACT_VALUE_LENGTH}`);
  return t;
}
function cleanScope(v) {
  const t = String(v || 'project').trim().toLowerCase();
  return ['project', 'user', 'session'].includes(t) ? t : 'project';
}
function parseCol(row, col) { if (!row) return null; const r = row[col]; return typeof r === 'string' ? JSON.parse(r) : r; }

export class PostgresMemoryStore {
  constructor({ pool = null, connectionString = null, now = () => new Date() } = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._now = now;
  }

  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresMemoryStore: pool or connectionString is required');
    let pg;
    try { pg = await import('pg'); } catch { throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`."); }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    this._pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    return this._pool;
  }

  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  async readMainMemory(trustedRoot, context = {}) {
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(
      `SELECT fact_json FROM memory_facts WHERE tenant_id=$1 ORDER BY created_at ASC, id ASC`,
      [tenantId],
    );
    if (!r.rows || !r.rows.length) return '';
    const lines = r.rows.map((row) => { const f = parseCol(row, 'fact_json'); return `- **${f.key}** (${f.scope}): ${f.value}\n`; });
    return clipUtf8(`${MEMORY_HEADER}${lines.join('')}`, MAX_MEMORY_BYTES);
  }

  async listMemoryNotes(trustedRoot, context = {}) {
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(
      `SELECT id, name, size, created_at, updated_at FROM memory_notes WHERE tenant_id=$1 ORDER BY name ASC`,
      [tenantId],
    );
    return (r.rows || []).map((row) => ({
      name: row.name,
      size: Number(row.size) || 0,
      modifiedAt: row.updated_at || row.created_at,
      path: `postgres://memory_notes/${row.id}`,
    }));
  }

  async readMemoryNote(trustedRoot, noteName, context = {}) {
    if (!NOTE_NAME_RE.test(String(noteName || ''))) throw new Error('Invalid memory note name');
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(`SELECT body FROM memory_notes WHERE tenant_id=$1 AND name=$2`, [tenantId, noteName]);
    const row = r.rows && r.rows[0];
    return row ? row.body : null;
  }

  async writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    if (!NOTE_NAME_RE.test(String(noteName || ''))) throw new Error('Invalid memory note name');
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const existing = await this._query(`SELECT id, created_at FROM memory_notes WHERE tenant_id=$1 AND name=$2`, [tenantId, noteName]);
    const prev = existing.rows && existing.rows[0];
    const id = (prev && prev.id) || memId('memnote');
    const now = this._now().toISOString();
    const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
    const note = { id, name: noteName, size: Buffer.byteLength(safeBody, 'utf8'), createdAt: (prev && prev.created_at) || now, updatedAt: now };
    await this._query(
      `INSERT INTO memory_notes (id, tenant_id, user_id, trace_id, name, body, size, created_at, updated_at, note_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         user_id=EXCLUDED.user_id, trace_id=EXCLUDED.trace_id, body=EXCLUDED.body,
         size=EXCLUDED.size, updated_at=EXCLUDED.updated_at, note_json=EXCLUDED.note_json`,
      [id, tenantId, userId, context.traceId || null, noteName, safeBody, note.size, note.createdAt, note.updatedAt, JSON.stringify(note)],
    );
    return `postgres://memory_notes/${id}`;
  }

  async appendMemoryFact(trustedRoot, fact, context = {}) {
    const key = cleanFactKey(fact && fact.key);
    const value = cleanFactValue(fact && fact.value);
    const scope = cleanScope(fact && fact.scope);
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const id = memId('memfact');
    const now = this._now().toISOString();
    const stored = { id, key, value, scope, createdAt: now };
    await this._query(
      `INSERT INTO memory_facts (id, tenant_id, user_id, trace_id, key, value, scope, created_at, updated_at, fact_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, tenantId, userId, context.traceId || null, key, value, scope, now, now, JSON.stringify(stored)],
    );
    return { file: `postgres://memory_facts/${id}`, fact: { key, value, scope } };
  }

  async buildMemorySystemBlock(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const main = await this.readMainMemory(trustedRoot, context);
    if (!main.trim()) return '';
    return clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes))).trim();
  }

  async loadMemoryContext(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const block = await this.buildMemorySystemBlock(trustedRoot, { maxBytes, context });
    const notes = (await this.listMemoryNotes(trustedRoot, context)).map((n) => ({ name: n.name, size: n.size, modifiedAt: n.modifiedAt }));
    return { enabled: Boolean(block), bytes: Buffer.byteLength(block, 'utf8'), text: block, notes };
  }

  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

export function createPostgresMemoryStore(options = {}) {
  return new PostgresMemoryStore(options);
}
