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
import crypto from 'node:crypto';

function defaultId() {
  return `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function sameTenant(meta = {}, context = null) {
  return !meta.tenantId || !!(context && context.tenantId === meta.tenantId);
}

export class PostgresApprovalStore {
  constructor({ client = null, pool = null, channel = 'kcw_approvals', generateId = defaultId } = {}) {
    // `client` is the dedicated LISTEN connection; `pool` runs queries. In tests
    // a single mock object can serve as both.
    this._client = client;
    this._pool = pool || client;
    this._channel = channel;
    this._local = new Map(); // id -> { resolve, meta } for promises awaited on THIS instance
    this._generateId = generateId;
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._client.on('notification', (msg) => {
      let data;
      try { data = JSON.parse(msg.payload); } catch { return; }
      const entry = this._local.get(data.id);
      if (entry) { this._local.delete(data.id); entry.resolve(data.decision); }
    });
    await this._client.query(`LISTEN ${this._channel}`);
  }

  request(meta = {}) {
    const id = this._generateId();
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    this._local.set(id, { resolve, meta });
    // Persist so another instance can resolve it; fire-and-forget (id is already
    // known, so the local resolver works regardless of insert latency).
    Promise.resolve(this._pool.query(
      `INSERT INTO pending_approvals (id, run_id, tenant_id, kind, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [id, meta.runId || null, meta.tenantId || null, meta.kind || null],
    )).catch(() => {});
    return { id, promise };
  }

  async _resolveRow(id, decision, context = null) {
    const params = [id, decision];
    const tenantClause = context && context.tenantId
      ? ` AND (tenant_id IS NULL OR tenant_id=$${params.push(context.tenantId)})`
      : ' AND tenant_id IS NULL';
    const r = await this._pool.query(
      `UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
       WHERE id=$1 AND status='pending'${tenantClause}`,
      params,
    );
    const rowMatched = Number(r.rowCount || 0) > 0;
    if (rowMatched) {
      await this._pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ id, decision })]);
    }
    // Local fast-path (same instance also awaiting).
    const local = this._local.get(id);
    const localMatched = !!(local && sameTenant(local.meta, context));
    if (localMatched) { this._local.delete(id); local.resolve(decision); }
    return rowMatched || localMatched;
  }

  async resolve(id, decision, context = null) {
    const DEC = new Set(['once', 'session', 'reject']);
    return this._resolveRow(id, DEC.has(decision) ? decision : 'reject', context);
  }

  async respond(id, value, context = null) {
    return this._resolveRow(id, value, context);
  }

  async cancelByRun(runId, decision = 'reject') {
    if (!runId) return 0;
    const rows = await this._pool.query(
      `UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
       WHERE run_id=$1 AND status='pending' RETURNING id`,
      [runId, decision],
    );
    const ids = (rows.rows || []).map((row) => row.id);
    for (const id of ids) {
      await this._pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ id, decision })]);
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve(decision); }
    }
    return Number(rows.rowCount || ids.length || 0);
  }

  async pendingCount() {
    const r = await this._pool.query(`SELECT COUNT(*)::int AS count FROM pending_approvals WHERE status='pending'`, []);
    return Number((r.rows && r.rows[0] && r.rows[0].count) || 0);
  }

  // Expire abandoned pending rows (cron-style sweep) so the table never grows
  // unbounded; locally resolves any matching awaiter with 'reject'.
  async prune(ttlMs = 15 * 60 * 1000) {
    const rows = await this._pool.query(
      `UPDATE pending_approvals SET status='expired', resolved_at=NOW()
       WHERE status='pending' AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond') RETURNING id`,
      [ttlMs],
    );
    const ids = (rows.rows || []).map((row) => row.id);
    for (const id of ids) {
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve('reject'); }
    }
    return ids.length;
  }
}

export function createPostgresApprovalStore(options = {}) {
  return new PostgresApprovalStore(options);
}
