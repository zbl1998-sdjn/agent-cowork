// PostgreSQL adapter for the runs index. Async methods stay await-compatible
// with sync file/sqlite adapters. `pg` is optional and lazily imported; tests
// inject a mock pool.
// @ts-check

/**
 * @typedef {{ rows?: unknown[], rowCount?: number | null }} PgResult
 * @typedef {{ query(text: string, params?: unknown[]): Promise<PgResult>, end?: () => Promise<unknown> }} PgPool
 * @typedef {new (options?: Record<string, unknown>) => PgPool} PgPoolConstructor
 * @typedef {{ default?: { Pool?: PgPoolConstructor }, Pool?: PgPoolConstructor }} PgModule
 * @typedef {{ id?: unknown, tenantId?: unknown, userId?: unknown, traceId?: unknown, type?: unknown, status?: unknown, mode?: unknown, provider?: unknown, recipeId?: unknown, startedAt?: unknown, finishedAt?: unknown, durationMs?: unknown, promptPreview?: unknown, error?: unknown, runPath?: unknown, version?: unknown, updatedAt?: unknown }} RunRecordInput
 * @typedef {{ id: string, tenantId: string, userId: string, traceId: string, type: string, status: string, mode: string | null, provider: string | null, recipeId: string | null, startedAt: unknown, finishedAt: unknown, durationMs: number | null, promptPreview: string | null, error: string | null, runPath: string | null, version: number, updatedAt: string }} RunRecord
 * @typedef {{ traceId?: unknown }} RunContext
 * @typedef {{ tenantId?: unknown }} RunsGetOptions
 * @typedef {{ tenantId?: unknown, userId?: unknown, limit?: unknown, status?: unknown, type?: unknown, recipeId?: unknown }} RunsListOptions
 * @typedef {{ tenantId?: unknown }} RunsStatsOptions
 * @typedef {{ total: number, byStatus: Record<string, number>, byType: Record<string, number> }} RunsStats
 * @typedef {{ pool?: PgPool | null, connectionString?: string | null, table?: string, now?: () => Date }} PostgresRunsIndexOptions
 * @typedef {{ record_json?: unknown, count?: unknown, status?: unknown, type?: unknown }} RunsIndexRow
 * @typedef {{ upsert(record: RunRecordInput, context?: RunContext): Promise<RunRecord>, remove(id: string): Promise<boolean>, get(id: string, options?: RunsGetOptions): Promise<RunRecord | null>, list(options?: RunsListOptions): Promise<RunRecord[]>, size(): Promise<number>, stats(options?: RunsStatsOptions): Promise<RunsStats>, close?: () => Promise<void> }} AsyncRunsIndex
 */

/** @param {unknown} value @param {string} fallback @returns {string} */
function clampId(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.length > 96 ? text.slice(0, 96) : text;
}
/** @param {unknown} v @returns {string} */
const normaliseTenantId = (v) => clampId(v, 'tenant_local');
/** @param {unknown} v @returns {string} */
const normaliseUserId = (v) => clampId(v, 'user_local');

/** @param {unknown} value @returns {string} */
function safePgIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresRunsIndex: invalid table name');
  }
  return text;
}

/** @param {unknown} record @returns {RunRecord} */
function normaliseRecord(record) {
  if (!record || typeof record !== 'object') throw new Error('runs-index: record must be an object');
  const input = /** @type {RunRecordInput} */ (record);
  const id = String(input.id || '').trim();
  if (!id) throw new Error('runs-index: record.id is required');
  return {
    id,
    tenantId: normaliseTenantId(input.tenantId),
    userId: normaliseUserId(input.userId),
    traceId: String(input.traceId || ''),
    type: String(input.type || ''),
    status: String(input.status || ''),
    mode: input.mode ? String(input.mode) : null,
    provider: input.provider ? String(input.provider) : null,
    recipeId: input.recipeId ? String(input.recipeId) : null,
    startedAt: input.startedAt || null,
    finishedAt: input.finishedAt || null,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
    promptPreview: typeof input.promptPreview === 'string' ? input.promptPreview.slice(0, 240) : null,
    error: input.error ? String(input.error).slice(0, 1024) : null,
    runPath: input.runPath ? String(input.runPath) : null,
    version: Number(input.version) || 1,
    updatedAt: String(input.updatedAt || new Date().toISOString()),
  };
}

/** @param {unknown} row @returns {RunRecord | null} */
function parseRecord(row) {
  if (!row) return null;
  const raw = (/** @type {RunsIndexRow} */ (row)).record_json;
  return /** @type {RunRecord | null} */ (typeof raw === 'string' ? JSON.parse(raw) : raw || null);
}

export class PostgresRunsIndex {
  /** @param {PostgresRunsIndexOptions} [options] */
  constructor({ pool = null, connectionString = null, table = 'runs_index', now = () => new Date() } = {}) {
    /** @type {PgPool | null} */
    this._pool = pool;
    /** @type {string | null} */
    this._connectionString = connectionString;
    /** @type {string} */
    this._table = safePgIdentifier(table);
    /** @type {() => Date} */
    this._now = now;
  }

  /** @returns {Promise<PgPool>} */
  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresRunsIndex: pool or connectionString is required');
    let pg;
    try { pg = /** @type {PgModule} */ (await import('pg')); } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg` in apps/host.");
    }
    const Pool = pg.default?.Pool || pg.Pool;
    if (!Pool) throw new Error("PostgreSQL backend requires the 'pg' Pool export.");
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** @param {string} text @param {unknown[]} [params] @returns {Promise<PgResult>} */
  async _query(text, params = []) {
    const pool = await this._getPool();
    return pool.query(text, params);
  }

  /** @param {RunRecordInput} record @param {RunContext} [context] @returns {Promise<RunRecord>} */
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
      [n.id, n.tenantId, n.userId, context.traceId ? String(context.traceId) : n.traceId, n.type, n.status, n.mode, n.provider, n.recipeId,
        n.startedAt, n.finishedAt, n.durationMs, n.promptPreview, n.error, n.runPath, n.version, createdAt, n.updatedAt, JSON.stringify(n)],
    );
    return n;
  }

  /** @param {string} id @returns {Promise<boolean>} */
  async remove(id) {
    const r = await this._query(`DELETE FROM ${this._table} WHERE id=$1`, [id]);
    return Number(r.rowCount || 0) > 0;
  }

  /** @param {string} id @param {RunsGetOptions} [options] @returns {Promise<RunRecord | null>} */
  async get(id, { tenantId } = {}) {
    const r = await this._query(`SELECT record_json FROM ${this._table} WHERE id=$1`, [id]);
    const rec = parseRecord(r.rows && r.rows[0]);
    if (!rec) return null;
    if (tenantId && rec.tenantId !== normaliseTenantId(tenantId)) return null;
    return rec;
  }

  /** @param {RunsListOptions} [options] @returns {Promise<RunRecord[]>} */
  async list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
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
    return /** @type {RunRecord[]} */ ((r.rows || []).map(parseRecord).filter(Boolean));
  }

  /** @returns {Promise<number>} */
  async size() {
    const r = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table}`, []);
    const row = /** @type {RunsIndexRow | undefined} */ (r.rows && r.rows[0]);
    return Number((row && row.count) || 0);
  }

  /** @param {RunsStatsOptions} [options] @returns {Promise<RunsStats>} */
  async stats({ tenantId } = {}) {
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
    const params = [];
    if (tenantId) { where.push('tenant_id=$1'); params.push(normaliseTenantId(tenantId)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table} ${w}`, params);
    const statusRows = await this._query(`SELECT status, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY status`, params);
    const typeRows = await this._query(`SELECT type, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY type`, params);
    /** @type {Record<string, number>} */
    const byStatus = Object.create(null);
    for (const row of statusRows.rows || []) {
      const statusRow = /** @type {RunsIndexRow} */ (row);
      byStatus[String(statusRow.status || '')] = Number(statusRow.count) || 0;
    }
    /** @type {Record<string, number>} */
    const byType = Object.create(null);
    for (const row of typeRows.rows || []) {
      const typeRow = /** @type {RunsIndexRow} */ (row);
      byType[String(typeRow.type || '')] = Number(typeRow.count) || 0;
    }
    const totalRow = /** @type {RunsIndexRow | undefined} */ (total.rows && total.rows[0]);
    return { total: Number((totalRow && totalRow.count) || 0), byStatus, byType };
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this._pool && typeof this._pool.end === 'function') await this._pool.end();
  }
}

/** @param {PostgresRunsIndexOptions} [options] @returns {PostgresRunsIndex} */
export function createPostgresRunsIndex(options = {}) {
  return new PostgresRunsIndex(options);
}

// Wrap an async index so unawaited write calls (upsert/remove are fire-and-forget
// at ~8 call sites) never surface as unhandledRejection, while awaited callers
// still receive the resolved value. Reads stay plain (route handlers await them).
/** @param {AsyncRunsIndex} index @returns {AsyncRunsIndex} */
export function withSafeWrites(index) {
  const close = index.close;
  return {
    upsert(record, context) {
      const result = index.upsert(record, context);
      result.then(undefined, () => {});
      return result;
    },
    remove(id) {
      const result = index.remove(id);
      result.then(undefined, () => {});
      return result;
    },
    get: (id, options) => index.get(id, options),
    list: (options) => index.list(options),
    size: () => index.size(),
    stats: (options) => index.stats(options),
    close: close ? () => close.call(index) : undefined,
  };
}
