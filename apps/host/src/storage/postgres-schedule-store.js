// PostgreSQL adapter for scheduled tasks — the multi-instance backend mirror of
// SqliteScheduleStore. Async (pg is promise-based); `pg` is lazily/optionally
// imported. Tests inject a mock pool.
// @ts-check

/**
 * @typedef {{ id: string, tenantId?: unknown, userId?: unknown, traceId?: unknown, name?: unknown, kind?: unknown, status?: unknown, cron?: unknown, fireAt?: unknown, nextFireAt?: unknown, lastFiredAt?: unknown, lastRunId?: unknown, version?: unknown, runs?: unknown, createdAt?: unknown, updatedAt?: unknown, [key: string]: unknown }} ScheduleRecord
 * @typedef {{ rows?: unknown[], rowCount?: number | null }} PgResult
 * @typedef {{ query(text: string, params?: unknown[]): Promise<PgResult>, end?: () => Promise<unknown> }} PgPool
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ScheduleListOptions
 * @typedef {{ pool?: PgPool | null, connectionString?: string | null, table?: string }} PostgresScheduleStoreOptions
 * @typedef {{ schedule_json?: unknown }} ScheduleRow
 */

/** @param {unknown} v @param {string} fb @returns {string} */
function clampId(v, fb) { const t = String(v || '').trim(); return t ? (t.length > 96 ? t.slice(0, 96) : t) : fb; }
/** @param {unknown} value @returns {string} */
function safePgIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresScheduleStore: invalid table name');
  }
  return text;
}
/** @param {unknown} v @returns {string} */
const normTenant = (v) => clampId(v, 'tenant_local');
/** @param {unknown} v @returns {string} */
const normUser = (v) => clampId(v, 'user_local');
/** @param {unknown} row @returns {ScheduleRecord | null} */
function parseJson(row) {
  if (!row) return null;
  const r = (/** @type {ScheduleRow} */ (row)).schedule_json;
  return typeof r === 'string' ? /** @type {ScheduleRecord} */ (JSON.parse(r)) : /** @type {ScheduleRecord | null} */ (r || null);
}

export class PostgresScheduleStore {
  /** @param {PostgresScheduleStoreOptions} [options] */
  constructor({ pool = null, connectionString = null, table = 'schedules' } = {}) {
    /** @type {PgPool | null} */
    this._pool = pool;
    /** @type {string | null} */
    this._connectionString = connectionString;
    /** @type {string} */
    this._table = safePgIdentifier(table);
  }

  /** @returns {Promise<PgPool>} */
  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresScheduleStore: pool or connectionString is required');
    let pg;
    try {
      pg = await import('pg');
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** @param {string} text @param {unknown[]} [params] @returns {Promise<PgResult>} */
  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  /** @param {ScheduleListOptions} [options] @returns {Promise<ScheduleRecord[]>} */
  async list({ tenantId, userId } = {}) {
    const where = [];
    const params = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(normTenant(tenantId)); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(normUser(userId)); }
    const r = await this._query(
      `SELECT schedule_json FROM ${this._table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY next_fire_at ASC NULLS LAST`,
      params,
    );
    return (r.rows || []).map(parseJson).filter((record) => record !== null);
  }

  /** @param {string} id @returns {Promise<ScheduleRecord | null>} */
  async get(id) {
    const r = await this._query(`SELECT schedule_json FROM ${this._table} WHERE id=$1`, [id]);
    return parseJson(r.rows && r.rows[0]);
  }

  /** @param {ScheduleRecord} record @returns {Promise<ScheduleRecord>} */
  async save(record) {
    await this._query(
      `INSERT INTO ${this._table}
        (id, tenant_id, user_id, trace_id, name, kind, status, cron, fire_at,
         next_fire_at, last_fired_at, last_run_id, version, runs, created_at, updated_at, schedule_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, trace_id=EXCLUDED.trace_id,
         name=EXCLUDED.name, kind=EXCLUDED.kind, status=EXCLUDED.status, cron=EXCLUDED.cron,
         fire_at=EXCLUDED.fire_at, next_fire_at=EXCLUDED.next_fire_at, last_fired_at=EXCLUDED.last_fired_at,
         last_run_id=EXCLUDED.last_run_id, version=EXCLUDED.version, runs=EXCLUDED.runs,
         updated_at=EXCLUDED.updated_at, schedule_json=EXCLUDED.schedule_json`,
      [record.id, normTenant(record.tenantId), normUser(record.userId), record.traceId || null, record.name || null,
        record.kind || null, record.status || null, record.cron || null, record.fireAt || null,
        record.nextFireAt || null, record.lastFiredAt || null, record.lastRunId || null,
        Number(record.version) || 1, Number(record.runs) || 0, record.createdAt || null, record.updatedAt || null,
        JSON.stringify(record)],
    );
    return record;
  }

  /** @param {string} id @returns {Promise<boolean>} */
  async remove(id) {
    const r = await this._query(`DELETE FROM ${this._table} WHERE id=$1`, [id]);
    return Number(r.rowCount || 0) > 0;
  }

  /** @returns {Promise<void>} */
  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** @param {PostgresScheduleStoreOptions} [options] @returns {PostgresScheduleStore} */
export function createPostgresScheduleStore(options = {}) {
  return new PostgresScheduleStore(options);
}
