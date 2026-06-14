// 跨实例审批存储(PostgreSQL + LISTEN/NOTIFY)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把待审批请求持久化到 pending_approvals 表,用 LISTEN/NOTIFY 做跨实例 pub/sub——
//       任一实例 resolve/respond/cancelByRun 都能唤醒持有 awaiting promise 的那个实例。
//       request() 保持同步(本地生成 id + fire-and-forget INSERT),不需改造 agent 循环。
// 依赖:仅标准库(crypto);pg 运行时按需 import。后端:PostgreSQL。
// 导出:PostgresApprovalStore(类) · createPostgresApprovalStore(工厂)。
import crypto from 'node:crypto';

type PgNotification = { payload?: string | null };
type PgResult = { rows?: unknown[]; rowCount?: number | null };
type PgClient = {
  on(event: 'notification', handler: (message: PgNotification) => void): unknown;
  query(text: string, params?: unknown[]): Promise<PgResult>;
  connect?: () => Promise<unknown>;
  end?: () => Promise<unknown>;
};
type PgPool = {
  query(text: string, params?: unknown[]): Promise<PgResult>;
  end?: () => Promise<unknown>;
};
type PgClientConstructor = new (options?: Record<string, unknown>) => PgClient;
type PgModule = {
  default?: { Client?: PgClientConstructor };
  Client?: PgClientConstructor;
};
type ApprovalMeta = { runId?: unknown; tenantId?: unknown; kind?: unknown; [key: string]: unknown };
type ApprovalContext = { tenantId?: unknown; [key: string]: unknown };
type ApprovalResolve = (decision: unknown) => void;
type LocalApproval = { resolve: ApprovalResolve; meta: ApprovalMeta };
export type PostgresApprovalStoreOptions = {
  client?: PgClient | null;
  pool?: PgPool | null;
  connectionString?: string | null;
  channel?: string;
  generateId?: () => string;
  pg?: PgModule | null;
};

/** 生成默认审批 id(apr_ 前缀)。 */
function defaultId(): string {
  return `apr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** 校验 NOTIFY 通道名合法(防 SQL 注入,通道名不能参数化)。 */
function safePgIdentifier(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresApprovalStore: invalid channel name');
  }
  return text;
}

/** 租户隔离:无 tenantId 视为公共,否则要求上下文租户匹配。 */
function sameTenant(meta: ApprovalMeta = {}, context: ApprovalContext | null = null): boolean {
  return !meta.tenantId || !!(context && context.tenantId === meta.tenantId);
}

/** 跨实例审批存储:PG 表持久化 + LISTEN/NOTIFY 跨实例唤醒本地 awaiting promise。 */
export class PostgresApprovalStore {
  private _client: PgClient | null;
  private _pool: PgPool | null;
  private _connectionString: string | null;
  private _pg: PgModule | null;
  private _channel: string;
  private _local: Map<string, LocalApproval>;
  private _generateId: () => string;
  private _started: boolean;

  constructor({ client = null, pool = null, connectionString = null, channel = 'kcw_approvals', generateId = defaultId, pg = null }: PostgresApprovalStoreOptions = {}) {
    // client 是专用 LISTEN 连接,pool 负责查询;测试里可用同一个 mock 同时扮演两者。
    this._client = client;
    this._pool = pool || client;
    this._connectionString = connectionString;
    this._pg = pg;
    this._channel = safePgIdentifier(channel);
    this._local = new Map(); // id -> { resolve, meta },仅保存本实例正在等待的 promise。
    this._generateId = generateId;
    this._started = false;
  }

  /** 取/建专用 LISTEN 连接(pg 按需 import,缺包给出安装提示)。 */
  async _getClient(): Promise<PgClient> {
    if (this._client) return this._client;
    if (!this._connectionString) throw new Error('PostgresApprovalStore: client or connectionString is required');
    let pg: PgModule;
    try {
      pg = this._pg || await import('pg') as PgModule;
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

  /** 取查询连接池(无则退回到 LISTEN 连接)。 */
  async _getPool(): Promise<PgPool> {
    if (this._pool) return this._pool;
    return this._getClient();
  }

  /** 启动跨实例监听:订阅通道,收到 NOTIFY 时唤醒本地匹配的 awaiter。 */
  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    const client = await this._getClient();
    client.on('notification', (msg) => {
      let data: unknown;
      if (typeof msg.payload !== 'string') return;
      try { data = JSON.parse(msg.payload); } catch { return; }
      const event = data as { id?: unknown; decision?: unknown };
      const id = String(event.id || '');
      const entry = this._local.get(id);
      if (entry) { this._local.delete(id); entry.resolve(event.decision); }
    });
    await client.query(`LISTEN ${this._channel}`);
  }

  /** 同步发起审批:本地生成 id 与 promise,持久化为 fire-and-forget INSERT。 */
  request(meta: ApprovalMeta = {}): { id: string; promise: Promise<unknown> } {
    const id = this._generateId();
    let resolve: ApprovalResolve = () => undefined;
    const promise = new Promise<unknown>((r) => { resolve = r; });
    this._local.set(id, { resolve, meta });
    // 持久化后其它实例也能解析;INSERT fire-and-forget,本地已知 id 不受写入延迟影响。
    Promise.resolve(this._getPool()).then((pool) => pool.query(
      `INSERT INTO pending_approvals (id, run_id, tenant_id, kind, status, created_at)
       VALUES ($1, $2, $3, $4, 'pending', NOW())`,
      [id, meta.runId || null, meta.tenantId || null, meta.kind || null],
    )).catch(() => undefined);
    return { id, promise };
  }

  /** 把行置为 resolved 并 NOTIFY,同时走本地快路径唤醒;返回是否命中(行或本地)。 */
  async _resolveRow(id: string, decision: unknown, context: ApprovalContext | null = null): Promise<boolean> {
    const params: unknown[] = [id, decision];
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
    // 本地快路径:发起审批的同一实例也在等待。
    const local = this._local.get(id);
    const localMatched = !!(local && sameTenant(local.meta, context));
    if (localMatched) { this._local.delete(id); local.resolve(decision); }
    return rowMatched || localMatched;
  }

  /** 解析审批决定:仅允许 once/session/reject,非法回落为 reject。 */
  async resolve(id: string, decision: unknown, context: ApprovalContext | null = null): Promise<boolean> {
    const DEC = new Set(['once', 'session', 'reject']);
    return this._resolveRow(id, typeof decision === 'string' && DEC.has(decision) ? decision : 'reject', context);
  }

  /** 批量按相同决定解析多个审批(去重后逐个 resolve)。 */
  async resolveMany(ids: unknown, decision: unknown, context: ApprovalContext | null = null): Promise<Array<{ id: string; ok: boolean }>> {
    const uniqueIds = [...new Set(Array.isArray(ids) ? ids.map((id) => String(id)) : [])];
    const results: Array<{ id: string; ok: boolean }> = [];
    for (const id of uniqueIds) {
      results.push({ id, ok: await this.resolve(id, decision, context) });
    }
    return results;
  }

  /** 以任意值响应审批(不受 once/session/reject 限制),用于自由表单决定。 */
  async respond(id: string, value: unknown, context: ApprovalContext | null = null): Promise<boolean> {
    return this._resolveRow(id, value, context);
  }

  /** 取消某次 run 名下所有 pending 审批(NOTIFY + 唤醒本地),返回取消数。 */
  async cancelByRun(runId: unknown, decision: unknown = 'reject'): Promise<number> {
    if (!runId) return 0;
    const pool = await this._getPool();
    const rows = await pool.query(
      `UPDATE pending_approvals SET status='resolved', decision=$2, resolved_at=NOW()
      WHERE run_id=$1 AND status='pending' RETURNING id`,
      [runId, decision],
    );
    const ids = (rows.rows || []).map((row) => String(((row as { id?: unknown }).id) || ''));
    for (const id of ids) {
      await pool.query(`SELECT pg_notify($1, $2)`, [this._channel, JSON.stringify({ id, decision })]);
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve(decision); }
    }
    return Number(rows.rowCount || ids.length || 0);
  }

  /** 统计当前 pending 审批行数。 */
  async pendingCount(): Promise<number> {
    const pool = await this._getPool();
    const r = await pool.query(`SELECT COUNT(*)::int AS count FROM pending_approvals WHERE status='pending'`, []);
    const row = (r.rows && r.rows[0]) as { count?: unknown } | undefined;
    return Number((row && row.count) || 0);
  }

  /** 清理超 TTL 的遗留 pending 行(置 expired),并本地以 reject 唤醒对应 awaiter。 */
  async prune(ttlMs = 15 * 60 * 1000): Promise<number> {
    const pool = await this._getPool();
    const rows = await pool.query(
      `UPDATE pending_approvals SET status='expired', resolved_at=NOW()
       WHERE status='pending' AND created_at < NOW() - ($1::int * INTERVAL '1 millisecond') RETURNING id`,
      [ttlMs],
    );
    const ids = (rows.rows || []).map((row) => String(((row as { id?: unknown }).id) || ''));
    for (const id of ids) {
      const local = this._local.get(id);
      if (local) { this._local.delete(id); local.resolve('reject'); }
    }
    return ids.length;
  }
}

/** 工厂:构造跨实例 Postgres 审批存储。 */
export function createPostgresApprovalStore(options: PostgresApprovalStoreOptions = {}): PostgresApprovalStore {
  return new PostgresApprovalStore(options);
}
