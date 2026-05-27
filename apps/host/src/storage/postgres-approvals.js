// Cross-instance approval store backed by PostgreSQL + LISTEN/NOTIFY.
//
// The in-memory registry only works within one process. To run the host behind
// a load balancer (P2), a pending approval requested on instance A must be
// resolvable by a POST that lands on instance B. This store persists pending
// requests in a table and uses LISTEN/NOTIFY as the cross-instance pub/sub: the
// resolving instance UPDATEs the row + NOTIFY; every instance LISTENs and, if it
// holds the awaiting promise locally, resolves it.
//
// `request()` stays SYNCHRONOUS (id generated locally, INSERT fire-and-forget),
// so the agent loop's call sites need no async migration; only resolve/respond/
// cancelByRun/pendingCount are async (called from the HTTP route, which awaits).
// @ts-check
import crypto from 'node:crypto';

/**
 * @typedef {{ payload?: string | null }} PgNotification
 * @typedef {{ rows?: unknown[], rowCount?: number | null }} PgResult
 * @typedef {{ on(event: 'notification', handler: (message: PgNotification) => void): unknown, query(text: string, params?: unknown[]): Promise<PgResult>, connect?: () => Promise<unknown>, end?: () => Promise<unknown> }} PgClient
 * @typedef {{ query(text: string, params?: unknown[]): Promise<PgResult>, end?: () => Promise<unknown> }} PgPool
 * @typedef {new (options?: Record<string, unknown>) => PgClient} PgClientConstructor
 * @typedef {{ default?: { Client?: PgClientConstructor }, Client?: PgClientConstructor }} PgModule
 * @typedef {{ runId?: unknown, tenantId?: unknown, kind?: unknown, [key: string]: unknown }} ApprovalMeta
 * @typedef {{ tenantId?: unknown, [key: string]: unknown }} ApprovalContext
 * @typedef {(decision: unknown) => void} ApprovalResolve
 * @typedef {{ resolve: ApprovalResolve, meta: ApprovalMeta }} LocalApproval
 * @typedef {{ client?: PgClient | null, pool?: PgPool | null, connectionString?: string | null, channel?: string, generateId?: () => string, pg?: PgModule | null }} PostgresApprovalStoreOptions
 */

/** @returns {string} */
function defaultId() {
  return `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** @param {unknown} value @returns {string} */
function safePgIdentifier(value) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresApprovalStore: invalid channel name');
  }
  return text;
}

/** @param {ApprovalMeta} [meta] @param {ApprovalContext | null} [context] @returns {boolean} */
function sameTenant(meta = {}, context = null) {
  return !meta.tenantId || !!(context && context.tenantId === meta.tenantId);
}

export class PostgresApprovalStore {
  /** @param {PostgresApprovalStoreOptions} [options] */
  constructor({ client = null, pool = null, connectionString = null, channel = 'kcw_approvals', generateId = defaultId, pg = null } = {}) {
    // `client` is the dedicated LISTEN connection; `pool` runs queries. In tests
    // a single mock object can serve as both.
    /** @type {PgClient | null} */
    this._client = client;
    /** @type {PgPool | null} */
    this._pool = pool || client;
    /** @type {string | null} */
    this._connectionString = connectionString;
    /** @type {PgModule | null} */
    this._pg = pg;
    /** @type {string} */
    this._channel = safePgIdentifier(channel);
    /** @type {Map<string, LocalApproval>} */
    this._local = new Map(); // id -> { resolve, meta } for promises awaited on THIS instance
    /** @type {() => string} */
    this._generateId = generateId;
    /** @type {boolean} */
    this._started = false;
  }

  /** @returns {Promise<PgClient>} */
  async _getClient() {
    if (this._client) return this._client;
    if (!this._connectionString) throw new Error('PostgresApprovalStore: client or connectionString is required');
    let pg;
    try {
      pg = this._pg || /** @type {PgModule} */ (await import('pg'));
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
    const Client = pg.default?.Client || pg.Client;
    if (!Client) throw new Error("PostgreSQL backend requires the 'pg' Client export.");
    const client = new Client({ connectionString: this._connectionString });
    if (typeof client.connect === 'function') await client.connect();
    this._client = client;
    if (!this._pool) this._pool = client;
    return client;
  }

  /** @returns {Promise<PgPool>} */
  async _getPool() {
    if (this._pool) return this._pool;
    return this._getClient();
  }

  /** @returns {Promise<void>} */
  async start() {
    if (this._started) return;
    this._started = true;
    const client = await this._getClient();
    client.on('notification', (msg) => {
      let data;
      if (typeof msg.payload !== 'string') return;
      try { data = JSON.parse(msg.payload); } catch { return; }
      const entry = this._local.get(data.id);
      if (entry) { this._local.delete(data.id); entry.resolve(data.decision); }
    });
    await client.query(`LISTEN ${this._channel}`);
  }

  /** @param {ApprovalMeta} [meta] @returns {{ id: string, promise: Promise<unknown> }} */
  request(meta = {}) {
    const id = this._generateId();
    /** @type {ApprovalResolve} */
    let resolve = () => {};
    const promise = new Promise((r) => { resolve = r; });
    this._local.set(id, { resolve: /** @type {ApprovalResolve} */ (resolve), meta });
    // Persist so another instance can resolve it; fire-and-forget (id is already
    // known, so the local resolver works regardless of insert latency).
    Promise.resolve(this._getPool()).then((pool) => pool.query(
      `INSERT INTO pending_approvals (id, run_id, tenant_id, kind, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [id, meta.runId || null, meta.tenantId || null, meta.kind || null],
    )).catch(() => {});
    return { id, promise };
  }

  /** @param {string} id @param {unknown} decision @param {ApprovalContext | null} [context] @returns {Promise<boolean>} */
  async _resolveRow(id, decision, context = null) {
    const params = [id, decision];
    const tenantClause = context && context.tenantId
      ? ` AND (tenant_id IS NULL OR tenant_id=$${params.push(context.tenantId)})`
      : ' AND tenant_id IS NULL';
    const pool = await this._getPool();
    const r = await pool.query(
      `UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
       WHERE id=$1 AND status='pending'${tenantClause}`,
      params,
    );
    const rowMatched = Number(r.rowCount || 0) > 0;
    if (rowMatched) {
      await pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ id, decision })]);
    }
    // Local fast-path (same instance also awaiting).
    const local = this._local.get(id);
    const localMatched = !!(local && sameTenant(local.meta, context));
    if (localMatched) { this._local.delete(id); local.resolve(decision); }
    return rowMatched || localMatched;
  }

  /** @param {string} id @param {unknown} decision @param {ApprovalContext | null} [context] @returns {Promise<boolean>} */
  async resolve(id, decision, context = null) {
    const DEC = new Set(['once', 'session', 'reject']);
    return this._resolveRow(id, typeof decision === 'string' && DEC.has(decision) ? decision : 'reject', context);
  }

  /** @param {unknown} ids @param {unknown} decision @param {ApprovalContext | null} [context] @returns {Promise<Array<{ id: string, ok: boolean }>>} */
  async resolveMany(ids, decision, context = null) {
    const uniqueIds = [...new Set(Array.isArray(ids) ? ids.map((id) => String(id)) : [])];
    const results = [];
    for (const id of uniqueIds) {
      results.push({ id, ok: await this.resolve(id, decision, context) });
    }
    return results;
  }

  /** @param {string} id @param {unknown} value @param {ApprovalContext | null} [context] @returns {Promise<boolean>} */
  async respond(id, value, context = null) {
    return this._resolveRow(id, value, context);
  }

  /** @param {unknown} runId @param {unknown} [decision] @returns {Promise<number>} */
  async cancelByRun(runId, decision = 'reject') {
    if (!runId) return 0;
    const pool = await this._getPool();
    const rows = await pool.query(
      `UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
       WHERE run_id=$1 AND status='pending' RETURNING id`,
      [runId, decision],
    );
    const ids = (rows.rows || []).map((row) => String((/** @type {{ id?: unknown }} */ (row)).id || ''));
    for (const id of ids) {
      await pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ id, decision })]);
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve(decision); }
    }
    return Number(rows.rowCount || ids.length || 0);
  }

  /** @returns {Promise<number>} */
  async pendingCount() {
    const pool = await this._getPool();
    const r = await pool.query(`SELECT COUNT(*)::int AS count FROM pending_approvals WHERE status='pending'`, []);
    return Number((r.rows && r.rows[0] && (/** @type {{ count?: unknown }} */ (r.rows[0])).count) || 0);
  }

  // Expire abandoned pending rows (cron-style sweep) so the table never grows
  // unbounded; locally resolves any matching awaiter with 'reject'.
  /** @param {number} [ttlMs] @returns {Promise<number>} */
  async prune(ttlMs = 15 * 60 * 1000) {
    const pool = await this._getPool();
    const rows = await pool.query(
      `UPDATE pending_approvals SET status='expired', resolved_at=NOW()
       WHERE status='pending' AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond') RETURNING id`,
      [ttlMs],
    );
    const ids = (rows.rows || []).map((row) => String((/** @type {{ id?: unknown }} */ (row)).id || ''));
    for (const id of ids) {
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve('reject'); }
    }
    return ids.length;
  }
}

/** @param {PostgresApprovalStoreOptions} [options] @returns {PostgresApprovalStore} */
export function createPostgresApprovalStore(options = {}) {
  return new PostgresApprovalStore(options);
}
