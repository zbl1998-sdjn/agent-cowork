// PostgreSQL adapter for per-user conversation history — multi-instance mirror
// of FileConversationStore. Async; `pg` lazily/optionally imported. Scoped by
// (tenant_id, user_id). Tests inject a mock pool.

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TITLE = 200;

function clampId(v, fb) { const t = String(v || '').trim(); return t ? t.slice(0, 96) : fb; }
const normTenant = (v) => clampId(v, 'tenant_local');
const normUser = (v) => clampId(v, 'user_local');

function cleanId(id) {
  const t = String(id || '').trim();
  if (!ID_RE.test(t)) throw new Error('invalid conversation id');
  return t;
}
function sanitizeMessages(messages) {
  return Array.isArray(messages) ? messages.slice(-200) : [];
}
function summariseRow(row) {
  return {
    id: row.id,
    title: row.title || '新对话',
    pinned: Boolean(row.pinned),
    messageCount: Number(row.message_count) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}
function parseMessages(row) {
  const m = row.messages;
  if (Array.isArray(m)) return m;
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return []; } }
  return [];
}
function fullRow(row) {
  return {
    id: row.id,
    title: row.title || '新对话',
    pinned: Boolean(row.pinned),
    messages: parseMessages(row),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export class PostgresConversationStore {
  constructor({ pool = null, connectionString = null, now = () => new Date() } = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._now = now;
  }

  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresConversationStore: pool or connectionString is required');
    let pg;
    try { pg = await import('pg'); } catch { throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`."); }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    this._pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    return this._pool;
  }

  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  async list(trustedRoot, context = {}) {
    const r = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC`,
      [normTenant(context.tenantId), normUser(context.userId)],
    );
    return (r.rows || []).map(summariseRow);
  }

  async query(trustedRoot, context = {}, { q = '', limit = 30, offset = 0 } = {}) {
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const ql = String(q || '').trim();
    const where = ql
      ? `tenant_id=$1 AND user_id=$2 AND title ILIKE $3`
      : `tenant_id=$1 AND user_id=$2`;
    const whereParams = ql ? [tenantId, userId, `%${ql}%`] : [tenantId, userId];
    const countRes = await this._query(`SELECT COUNT(*)::int AS total FROM conversations WHERE ${where}`, whereParams);
    const total = (countRes.rows && countRes.rows[0] && Number(countRes.rows[0].total)) || 0;
    const rowsRes = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count, created_at, updated_at
       FROM conversations WHERE ${where} ORDER BY updated_at DESC LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
      [...whereParams, lim, off],
    );
    return { items: (rowsRes.rows || []).map(summariseRow), total };
  }

  async listFull(trustedRoot, context = {}, { limit } = {}) {
    const hasLimit = typeof limit === 'number';
    const r = await this._query(
      `SELECT id, title, pinned, messages, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC${hasLimit ? ' LIMIT $3' : ''}`,
      hasLimit ? [normTenant(context.tenantId), normUser(context.userId), Math.max(0, limit)] : [normTenant(context.tenantId), normUser(context.userId)],
    );
    return (r.rows || []).map(fullRow);
  }

  async get(trustedRoot, id, context = {}) {
    const r = await this._query(
      `SELECT id, title, pinned, messages, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [normTenant(context.tenantId), normUser(context.userId), cleanId(id)],
    );
    const row = r.rows && r.rows[0];
    return row ? fullRow(row) : null;
  }

  async save(trustedRoot, conv, context = {}) {
    const id = cleanId(conv && conv.id);
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const now = this._now().toISOString();
    const title = String((conv && conv.title) || '新对话').slice(0, MAX_TITLE);
    const pinned = Boolean(conv && conv.pinned);
    const messages = sanitizeMessages(conv && conv.messages);
    const r = await this._query(
      `INSERT INTO conversations (tenant_id, user_id, id, title, pinned, messages, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
       ON CONFLICT (tenant_id, user_id, id) DO UPDATE SET
         title=EXCLUDED.title, pinned=EXCLUDED.pinned, messages=EXCLUDED.messages, updated_at=EXCLUDED.updated_at
       RETURNING id, title, pinned, jsonb_array_length(messages) AS message_count, created_at, updated_at`,
      [tenantId, userId, id, title, pinned, JSON.stringify(messages), now, now],
    );
    const row = (r.rows && r.rows[0]) || { id, title, pinned, message_count: messages.length, created_at: now, updated_at: now };
    return summariseRow(row);
  }

  async remove(trustedRoot, id, context = {}) {
    const r = await this._query(
      `DELETE FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [normTenant(context.tenantId), normUser(context.userId), cleanId(id)],
    );
    return (r.rowCount || 0) > 0;
  }

  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

export function createPostgresConversationStore(options = {}) {
  return new PostgresConversationStore(options);
}
