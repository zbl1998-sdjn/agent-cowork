// 运行索引(runs index)的 PostgreSQL 适配(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把每次 run 的元数据 upsert 到索引表并支持 get/list/size/stats,字段做归一与截断;
//       附带 withSafeWrites 包装,让 fire-and-forget 的写不会冒出 unhandledRejection。
// 依赖:无(仅 pg 运行时按需 import)。后端:PostgreSQL(表名经 safePgIdentifier 校验)。
// 导出:PostgresRunsIndex(类) · createPostgresRunsIndex(工厂) · withSafeWrites(写包装)。
import type {
  AsyncRunsIndex,
  PgPool,
  PgResult,
  PostgresRunsIndexOptions,
  RunContext,
  RunRecord,
  RunRecordInput,
  RunsGetOptions,
  RunsListOptions,
  RunsStats,
  RunsStatsOptions,
} from './postgres-runs-index-types.js';
import {
  canonicalIdentityFilter,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';
import {
  normaliseRecord,
  parseRecord,
  safePgIdentifier,
} from './postgres-runs-index-records.js';

export type {
  AsyncRunsIndex,
  PgPool,
  PgResult,
  PostgresRunsIndexOptions,
  RunContext,
  RunRecord,
  RunRecordInput,
  RunsGetOptions,
  RunsListOptions,
  RunsStats,
  RunsStatsOptions,
} from './postgres-runs-index-types.js';

type PgPoolConstructor = new (options?: Record<string, unknown>) => PgPool;
type PgModule = { default?: { Pool?: PgPoolConstructor }; Pool?: PgPoolConstructor };
type RunsIndexRow = { record_json?: unknown; count?: unknown; status?: unknown; type?: unknown };

function requireOwnerContext(context: RunContext): { tenantId: string; userId: string } {
  return requireIdentityScopeFrom(context, { label: 'runs-index owner context' });
}

/** 运行索引的 PG 后端:upsert 写入并提供 get/list/size/stats 查询。 */
export class PostgresRunsIndex {
  private _pool: PgPool | null;
  private _connectionString: string | null;
  private _table: string;
  private _now: () => Date;

  constructor({ pool = null, connectionString = null, table = 'runs_index', now = () => new Date() }: PostgresRunsIndexOptions = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._table = safePgIdentifier(table);
    this._now = now;
  }

  /** 取/建连接池(pg 按需 import,缺包给出安装提示)。 */
  async _getPool(): Promise<PgPool> {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresRunsIndex: pool or connectionString is required');
    let pg: PgModule;
    try { pg = await import('pg') as PgModule; } catch {
      throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg` in apps/host.");
    }
    const Pool = pg.default?.Pool || pg.Pool;
    if (!Pool) throw new Error("PostgreSQL backend requires the 'pg' Pool export.");
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** 取池后执行参数化查询。 */
  async _query(text: string, params: unknown[] = []): Promise<PgResult> {
    const pool = await this._getPool();
    return pool.query(text, params);
  }

  /** 插入或更新一条 run 记录(已存在则版本号 +1),返回归一后的记录。 */
  async upsert(record: RunRecordInput, context: RunContext = {}): Promise<RunRecord> {
    const n = normaliseRecord(record);
    const now = this._now().toISOString();
    n.updatedAt = now;
    const createdAt = n.startedAt || now;
    const result = await this._query(
      `INSERT INTO ${this._table} AS current_run
        (id, tenant_id, user_id, trace_id, type, status, mode, provider, recipe_id,
         started_at, finished_at, duration_ms, prompt_preview, error, run_path,
         version, created_at, updated_at, record_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         trace_id=EXCLUDED.trace_id, type=EXCLUDED.type, status=EXCLUDED.status,
         mode=EXCLUDED.mode, provider=EXCLUDED.provider,
         recipe_id=EXCLUDED.recipe_id, started_at=EXCLUDED.started_at, finished_at=EXCLUDED.finished_at,
         duration_ms=EXCLUDED.duration_ms, prompt_preview=EXCLUDED.prompt_preview, error=EXCLUDED.error,
         run_path=EXCLUDED.run_path, version=current_run.version + 1, updated_at=EXCLUDED.updated_at,
         record_json=EXCLUDED.record_json || jsonb_build_object('version', current_run.version + 1)
       WHERE current_run.tenant_id = EXCLUDED.tenant_id
         AND current_run.user_id = EXCLUDED.user_id
       RETURNING record_json`,
      [n.id, n.tenantId, n.userId, context.traceId ? String(context.traceId) : n.traceId, n.type, n.status, n.mode, n.provider, n.recipeId,
        n.startedAt, n.finishedAt, n.durationMs, n.promptPreview, n.error, n.runPath, n.version, createdAt, n.updatedAt, JSON.stringify(n)],
    );
    if (result.rowCount !== 1) {
      throw new Error('runs-index: id already belongs to another owner');
    }
    const stored = parseRecord(result.rows && result.rows[0]);
    if (!stored) {
      throw new Error('runs-index: upsert did not return a record');
    }
    return stored;
  }

  /** 按 id 删除一条记录,返回是否真的删除。 */
  async remove(id: string, context: RunContext = {}): Promise<boolean> {
    const owner = requireOwnerContext(context);
    const r = await this._query(
      `DELETE FROM ${this._table} WHERE id=$1 AND tenant_id=$2 AND user_id=$3`,
      [id, owner.tenantId, owner.userId],
    );
    return Number(r.rowCount || 0) > 0;
  }

  /** 取单条记录;给定 tenant/user 时在 SQL 与返回值上执行精确归属校验。 */
  async get(id: string, options: RunsGetOptions = {}): Promise<RunRecord | null> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where = ['id=$1'];
    const params: unknown[] = [id];
    let i = 2;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
    const r = await this._query(`SELECT record_json FROM ${this._table} WHERE ${where.join(' AND ')}`, params);
    const rec = parseRecord(r.rows && r.rows[0]);
    if (!rec) return null;
    if (tenantId && rec.tenantId !== tenantId) return null;
    if (userId && rec.userId !== userId) return null;
    return rec;
  }

  /** 按可选条件(租户/用户/状态/类型/recipe)动态拼 WHERE 列表,按时间倒序,limit 夹在 1~500。 */
  async list(options: RunsListOptions = {}): Promise<RunRecord[]> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const { limit = 50, status, type, recipeId } = options;
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
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
    return (r.rows || []).map(parseRecord).filter((record): record is RunRecord => Boolean(record));
  }

  /** 返回索引表总行数。 */
  async size(): Promise<number> {
    const r = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table}`, []);
    const row = (r.rows && r.rows[0]) as RunsIndexRow | undefined;
    return Number((row && row.count) || 0);
  }

  /** 统计运行总数及按 status/type 的分组计数(可选按租户/用户过滤)。 */
  async stats(options: RunsStatsOptions = {}): Promise<RunsStats> {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (tenantId) { where.push(`tenant_id=$${i++}`); params.push(tenantId); }
    if (userId) { where.push(`user_id=$${i++}`); params.push(userId); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this._query(`SELECT COUNT(*)::int AS count FROM ${this._table} ${w}`, params);
    const statusRows = await this._query(`SELECT status, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY status`, params);
    const typeRows = await this._query(`SELECT type, COUNT(*)::int AS count FROM ${this._table} ${w} GROUP BY type`, params);
    const byStatus: Record<string, number> = Object.create(null);
    for (const row of statusRows.rows || []) {
      const statusRow = row as RunsIndexRow;
      byStatus[String(statusRow.status || '')] = Number(statusRow.count) || 0;
    }
    const byType: Record<string, number> = Object.create(null);
    for (const row of typeRows.rows || []) {
      const typeRow = row as RunsIndexRow;
      byType[String(typeRow.type || '')] = Number(typeRow.count) || 0;
    }
    const totalRow = (total.rows && total.rows[0]) as RunsIndexRow | undefined;
    return { total: Number((totalRow && totalRow.count) || 0), byStatus, byType };
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    if (this._pool && typeof this._pool.end === 'function') await this._pool.end();
  }
}

/** 工厂:构造 PG 后端运行索引。 */
export function createPostgresRunsIndex(options: PostgresRunsIndexOptions = {}): PostgresRunsIndex {
  return new PostgresRunsIndex(options);
}

/** 包装异步索引,使 upsert/remove 的 fire-and-forget 写吞掉 rejection,读方法原样透传。 */
export function withSafeWrites(index: AsyncRunsIndex): AsyncRunsIndex {
  const close = index.close;
  const wrapped: Omit<AsyncRunsIndex, 'close'> = {
    upsert(record, context) {
      const result = index.upsert(record, context);
      result.then(undefined, () => undefined);
      return result;
    },
    remove(id, context) {
      const result = index.remove(id, context);
      result.then(undefined, () => undefined);
      return result;
    },
    get: (id, options) => index.get(id, options),
    list: (options) => index.list(options),
    size: () => index.size(),
    stats: (options) => index.stats(options),
  };
  return close ? { ...wrapped, close: () => close.call(index) } : wrapped;
}
