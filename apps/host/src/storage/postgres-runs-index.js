// PostgreSQL adapter for the runs index — the multi-instance / high-concurrency
// data backend (the file & SQLite adapters are single-node only). Methods are
// ASYNC because `pg` is promise-based; callers must `await`. The sync file/
// sqlite adapters stay await-compatible (awaiting a plain value is a no-op), so
// route handlers can `await runsIndex.list(...)` uniformly.
//
// `pg` is an OPTIONAL, lazily-imported dependency: the default host stays
// zero-dependency, and Postgres is enabled only when an operator installs `pg`
// and sets KCW_STORE=postgres + DATABASE_URL. Unit tests inject a mock pool.

function clampId(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.length > 96 ? text.slice(0, 96) : text;
}
const normaliseTenantId = (v) => clampId(v, 'tenant_local');
const normaliseUserId = (v) => clampId(v, 'user_local');

function normaliseRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('runs-index: record must be an object');
  const id = String(record.id || '').trim();
  if (!id) throw new Error('runs-index: record.id is required');
  return {
    id,
    tenantId: normaliseTenantId(record.tenantId),
    userId: normaliseUserId(record.userId),
    traceId: String(record.traceId || ''),
    type: String(record.type || ''),
    status: String(record.status || ''),
    mode: record.mode ? String(record.mode) : null,
    provider: record.provider ? String(record.provider) : null,
    recipeId: record.recipeId ? String(record.recipeId) : null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
    promptPreview: typeof record.promptPreview === 'string' ? record.promptPreview.slice(0, 240) : null,
    error: record.error ? String(record.error).slice(0, 1024) : null,
    runPath: record.runPath ? String(record.runPath) : null,
    version: Number(record.version) || 1,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}

function parseRecord(row) {
  if (!row) return null;
  const raw = row.record_json;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export class PostgresRunsIndex {
  constructor({ pool = null, connectionString = null, table = 'runs_index', now = () => new Date() } = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._table = table;
    this._now = now;
  }

  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresRunsIndex: pool or connectionString is required');
    let pg;
    try { pg = await import('pg'); } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg` in apps/host.");
    }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    this._pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    return this._pool;
  }

  async _query(text, params = []) {
    const pool = await this._getPool();
    return pool.query(text, params);
  }

  async upsert(record, context = {}) {
    const n = normaliseRecord(record);
    const existing = await this.get(n.id);
    const now = this._now().toISOString();
    if (existing) n.version = (Number(existing.version) || 0) + 1;
    n.updatedAt = now;
    const createdAt = (existing && (existing.startedAt || existing.updatedAt)) || n.startedAt || now;
    await this._query(
      `INSERT INTO ${this._table}
        (id, tenant_id, user_id, trace_id, type, status, mode, provider, recipe_id,
         started_at, finished_at, duration_ms, prompt_preview, error, run_path,
         version, created_at, updated_at, record_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, trace_id=EXCLUDED.trace_id,
         type=EXCLUDED.type, status=EXCLUDED.status, mode=EXCLUDED.mode, provider=EXCLUDED.provider,
         recipe_id=EXCLUDED.recipe_id, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at,
         duration_ms=EXCLUDED.duration_ms, prompt_preview=EXCLUDED.prompt_preview, error=EXCLUDED.error,
         run_path=EXCLUDED.run_path, version=EXCLUDED.version, updated_at=EXCLUDED.updated_at,
         record_json=EXCLUDED.record_json`,
      [n.id, n.tenantId, n.userId, context.traceId || n.traceId, n.type, n.status, n.mode, n.provider, n.recipeId,
        n.startedAt, n.finishedAt, n.durationMs, n.promptPreview, n.error, n.runPath, n.version, createdAt, n.updatedAt, JSON.stringify(n)],
    );
    return n;
  }

  async remove(id) {
    const r = await this._query(`DELETE FROM ${this._table} WHERE id=$1`, [id]);
    return Number(r.rowCount || 0) > 0;
  }

  async get(id, { tenantId } = {}) {
    const r = await this._query(`SELECT record_json FROM ${this._table} WHERE id=$1`, [id]);
    const rec = parseRecord(r.rows && r.rows[0]);
    if (!rec) return null;
    if (tenantId && rec.tenantId !== normaliseTenantId(tenantId)) return null;
    return rec;
  }

  async list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(normaliseTenantId(tenantId)); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(normaliseUserId(userId)); }
    if (status) { where.push(`status=$${i++}`); params.push(String(status)); }
    if (type) { where.push(`type=$${i++}`); params.push(String(type)); }
    if (recipeId) { where.push(`recipe_id=$${i++}`); params.push(String(recipeId)); }
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    params.push(cap);
    const r = await this._query(
      `SELECT record_json FROM ${this._table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY COALESCE(started_at, updated_at, created_at) DESC
       LIMIT $${i}`,
      params,
    );
    return (r.rows || []).map(parseRecord).filter(Boolean);
  }

  async size() {
    const r = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table}`, []);
    return Number((r.rows && r.rows[0] && r.rows[0].count) || 0);
  }

  async stats({ tenantId } = {}) {
    const where = [];
    const params = [];
    if (tenantId) { where.push('tenant_id=$1'); params.push(normaliseTenantId(tenantId)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table} ${w}`, params);
    const statusRows = await this._query(`SELECT status, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY status`, params);
    const typeRows = await this._query(`SELECT type, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY type`, params);
    const byStatus = Object.create(null);
    for (const row of statusRows.rows || []) byStatus[row.status] = Number(row.count) || 0;
    const byType = Object.create(null);
    for (const row of typeRows.rows || []) byType[row.type] = Number(row.count) || 0;
    return { total: Number((total.rows && total.rows[0] && total.rows[0].count) || 0), byStatus, byType };
  }

  async close() {
    if (this._pool && typeof this._pool.end === 'function') await this._pool.end();
  }
}

export function createPostgresRunsIndex(options = {}) {
  return new PostgresRunsIndex(options);
}

// Wrap an async index so unawaited write calls (upsert/remove are fire-and-forget
// at ~8 call sites) never surface as unhandledRejection, while awaited callers
// still receive the resolved value. Reads stay plain (route handlers await them).
export function withSafeWrites(index) {
  const safe = (fn) => (...args) => {
    const r = fn.apply(index, args);
    if (r && typeof r.then === 'function') r.then(undefined, () => {});
    return r;
  };
  return {
    upsert: safe(index.upsert),
    remove: safe(index.remove),
    get: (...a) => index.get(...a),
    list: (...a) => index.list(...a),
    size: (...a) => index.size(...a),
    stats: (...a) => index.stats(...a),
    close: index.close ? (...a) => index.close(...a) : undefined,
  };
}
