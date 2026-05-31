// 调度存储的同步外观:内存镜像 + 异步 Postgres 写穿(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:为同步读写的 Scheduler 运行时包装异步 PostgresScheduleStore——启动时从 PG
//       水合到内存 Map,list/get 走内存,save/remove 写内存并异步写穿 PG。
// 依赖:同层 postgres-schedule-store(L1)。后端:PostgreSQL(经其适配)。
// 导出:CachedPostgresScheduleStore(类) · createCachedPostgresScheduleStore(工厂)。
//
// Sync-facade over the async PostgresScheduleStore.
//
// The Scheduler runtime reads/writes its store synchronously (list().filter(),
// get(), save()), so it can't await a Postgres pool directly. This facade keeps
// an in-memory mirror that hydrates from Postgres on startup and is written
// through on every save/remove — giving the sync Scheduler PG durability without
// an async refactor. On a single instance PG is the source of truth across
// restarts; multi-instance schedule firing additionally needs a distributed
// lock (out of scope here).
import { PostgresScheduleStore } from './postgres-schedule-store.js';
import type { PgPool, ScheduleListOptions, ScheduleRecord } from './postgres-schedule-store.js';

type AsyncScheduleStore = {
  list(options?: ScheduleListOptions): Promise<ScheduleRecord[]>;
  get(id: string): Promise<ScheduleRecord | null>;
  save(record: ScheduleRecord): Promise<ScheduleRecord>;
  remove(id: string): Promise<boolean>;
};
export type CachedPostgresScheduleStoreOptions = {
  pool?: PgPool | null;
  connectionString?: string | null;
  pg?: AsyncScheduleStore | null;
};

/** 同步外观:对外暴露同步 list/get/save/remove,背后用内存 Map 镜像 + 异步 PG 写穿。 */
export class CachedPostgresScheduleStore {
  private _pg: AsyncScheduleStore;
  private _cache: Map<string, ScheduleRecord>;
  private _hydrated: boolean;
  private _hydrating: Promise<void> | null;

  constructor({ pool = null, connectionString = null, pg = null }: CachedPostgresScheduleStoreOptions = {}) {
    this._pg = pg || new PostgresScheduleStore({ pool, connectionString });
    this._cache = new Map(); // id -> record
    this._hydrated = false;
    this._hydrating = null;
    void this.hydrate();
  }

  /** 启动时从 PG 拉全量记录灌入内存缓存(去重、幂等);失败则降级仅用缓存。 */
  hydrate(): Promise<void> {
    if (this._hydrated) return Promise.resolve();
    if (this._hydrating) return this._hydrating;
    this._hydrating = Promise.resolve(this._pg.list({}))
      .then((rows) => { for (const r of rows || []) this._cache.set(r.id, r); this._hydrated = true; })
      .catch(() => { /* best-effort; serve from cache */ })
      .finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  /** 同步列出缓存中的调度记录,可按租户/用户过滤,按 nextFireAt 升序。 */
  list({ tenantId, userId }: ScheduleListOptions = {}): ScheduleRecord[] {
    let out = [...this._cache.values()];
    if (tenantId) out = out.filter((r) => r.tenantId === tenantId);
    if (userId) out = out.filter((r) => r.userId === userId);
    return out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
  }

  /** 同步从缓存取单条调度记录。 */
  get(id: string): ScheduleRecord | null {
    return this._cache.get(id) || null;
  }

  /** 写缓存并异步写穿 PG(失败靠下次 save 重试);同步返回入参记录。 */
  save(record: ScheduleRecord): ScheduleRecord {
    this._cache.set(record.id, record);
    Promise.resolve(this._pg.save(record)).catch(() => { /* cache holds it; PG retried on next save */ });
    return record;
  }

  /** 从缓存删除并异步在 PG 删除;同步返回缓存中是否曾存在。 */
  remove(id: string): boolean {
    const had = this._cache.delete(id);
    Promise.resolve(this._pg.remove(id)).catch(() => {});
    return had;
  }
}

/** 工厂:构造带 PG 写穿的同步调度存储外观。 */
export function createCachedPostgresScheduleStore(options: CachedPostgresScheduleStoreOptions = {}): CachedPostgresScheduleStore {
  return new CachedPostgresScheduleStore(options);
}
