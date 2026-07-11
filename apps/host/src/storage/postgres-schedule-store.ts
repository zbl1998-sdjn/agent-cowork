// 计划任务的 PostgreSQL 适配(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:SqliteScheduleStore 的多实例 PG 镜像——把调度记录 upsert 到 schedules 表,
//       提供 list(可按租户/用户过滤、按 nextFireAt 排序)/get/save/remove,整记录存 schedule_json。
// 依赖:无(仅 pg 运行时按需 import)。后端:PostgreSQL(表名经 safePgIdentifier 校验)。
// 导出:PostgresScheduleStore(类) · createPostgresScheduleStore(工厂)。
import {
  canonicalIdentityFilter,
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

export type ScheduleRecord = {
  id: string;
  tenantId?: unknown;
  userId?: unknown;
  traceId?: unknown;
  name?: unknown;
  kind?: unknown;
  status?: unknown;
  cron?: unknown;
  fireAt?: unknown;
  nextFireAt?: unknown;
  lastFiredAt?: unknown;
  lastRunId?: unknown;
  version?: unknown;
  runs?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
};
export type PgResult = { rows?: unknown[]; rowCount?: number | null };
export type PgPool = { query(text: string, params?: unknown[]): Promise<PgResult>; end?: () => Promise<unknown> };
export type ScheduleListOptions = { tenantId?: unknown; userId?: unknown };
export type PostgresScheduleStoreOptions = { pool?: PgPool | null; connectionString?: string | null; table?: string };
type ScheduleRow = { schedule_json?: unknown };
type PgPoolConstructor = new (options?: Record<string, unknown>) => PgPool;
type PgModule = { default?: { Pool?: PgPoolConstructor }; Pool?: PgPoolConstructor };

/** 校验表名合法(表名拼进 SQL 不能参数化,需防注入)。 */
function safePgIdentifier(value: unknown): string {
  const text = String(value || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(text)) {
    throw new Error('PostgresScheduleStore: invalid table name');
  }
  return text;
}
/** 从行的 schedule_json 列还原调度记录(字符串则 parse,兼容 jsonb 直返)。 */
function parseJson(row: unknown): ScheduleRecord | null {
  if (!row) return null;
  const raw = (row as ScheduleRow).schedule_json;
  let parsed: unknown;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as ScheduleRecord;
  return canonicalRequiredIdentityScope(record.tenantId, record.userId) ? record : null;
}

/** 计划任务的 PG 后端:整记录存 schedule_json,提供 list/get/save(upsert)/remove。 */
export class PostgresScheduleStore {
  private _pool: PgPool | null;
  private _connectionString: string | null;
  private _table: string;

  constructor({ pool = null, connectionString = null, table = 'schedules' }: PostgresScheduleStoreOptions = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._table = safePgIdentifier(table);
  }

  /** 取/建连接池(pg 按需 import,缺包给出安装提示)。 */
  async _getPool(): Promise<PgPool> {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresScheduleStore: pool or connectionString is required');
    let pg: PgModule;
    try {
      pg = await import('pg') as PgModule;
    } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`.");
    }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    if (!Pool) {
      throw new Error("PostgreSQL backend requires the 'pg' Pool export.");
    }
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** 取池后执行参数化查询。 */
  async _query(text: string, params: unknown[] = []): Promise<PgResult> { const pool = await this._getPool(); return pool.query(text, params); }

  /** 列出调度记录,可按租户/用户过滤,按 next_fire_at 升序(NULL 排最后)。 */
  async list(options: ScheduleListOptions = {}): Promise<ScheduleRecord[]> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
    const r = await this._query(
      `SELECT schedule_json FROM ${this._table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY next_fire_at ASC NULLS LAST`,
      params,
    );
    return (r.rows || []).map(parseJson).filter((record): record is ScheduleRecord => record !== null);
  }

  /** 按 id 与可选 tenant/user owner scope 取单条调度记录,不存在或越权返回 null。 */
  async get(id: string, options: ScheduleListOptions = {}): Promise<ScheduleRecord | null> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where = ['id=$1'];
    const params: unknown[] = [id];
    let i = 2;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
    const r = await this._query(
      `SELECT schedule_json FROM ${this._table} WHERE ${where.join(' AND ')}`,
      params,
    );
    return parseJson(r.rows && r.rows[0]);
  }

  /** upsert 调度记录(按 id 冲突更新,各列与 schedule_json 同步),返回入参记录。 */
  async save(record: ScheduleRecord): Promise<ScheduleRecord> {
    const owner = requireIdentityScopeFrom(record, { label: 'schedule record identity' });
    const result = await this._query(
      `INSERT INTO ${this._table} AS current_schedule
        (id, tenant_id, user_id, trace_id, name, kind, status, cron, fire_at,
         next_fire_at, last_fired_at, last_run_id, version, runs, created_at, updated_at, schedule_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, trace_id=EXCLUDED.trace_id,
         name=EXCLUDED.name, kind=EXCLUDED.kind, status=EXCLUDED.status, cron=EXCLUDED.cron,
         fire_at=EXCLUDED.fire_at, next_fire_at=EXCLUDED.next_fire_at, last_fired_at=EXCLUDED.last_fired_at,
         last_run_id=EXCLUDED.last_run_id, version=EXCLUDED.version, runs=EXCLUDED.runs,
         updated_at=EXCLUDED.updated_at, schedule_json=EXCLUDED.schedule_json
       WHERE current_schedule.tenant_id = EXCLUDED.tenant_id
         AND current_schedule.user_id = EXCLUDED.user_id`,
      [record.id, owner.tenantId, owner.userId, record.traceId || null, record.name || null,
        record.kind || null, record.status || null, record.cron || null, record.fireAt || null,
        record.nextFireAt || null, record.lastFiredAt || null, record.lastRunId || null,
        Number(record.version) || 1, Number(record.runs) || 0, record.createdAt || null, record.updatedAt || null,
        JSON.stringify(record)],
    );
    if (result.rowCount !== 1) {
      throw new Error('PostgresScheduleStore: id already belongs to another owner');
    }
    return record;
  }

  /** 按 id 与可选 tenant/user owner scope 删除一条调度记录,越权时返回 false。 */
  async remove(id: string, options: ScheduleListOptions = {}): Promise<boolean> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where = ['id=$1'];
    const params: unknown[] = [id];
    let i = 2;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
    const r = await this._query(
      `DELETE FROM ${this._table} WHERE ${where.join(' AND ')}`,
      params,
    );
    return Number(r.rowCount || 0) > 0;
  }

  /** 关闭连接池。 */
  async close(): Promise<void> { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** 工厂:构造 PG 后端调度存储。 */
export function createPostgresScheduleStore(options: PostgresScheduleStoreOptions = {}): PostgresScheduleStore {
  return new PostgresScheduleStore(options);
}
