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
// @ts-check
import { PostgresScheduleStore } from './postgres-schedule-store.js';

/**
 * @typedef {{ id: string, tenantId?: unknown, userId?: unknown, nextFireAt?: unknown, [key: string]: unknown }} ScheduleRecord
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ScheduleListOptions
 * @typedef {{ list(options?: ScheduleListOptions): Promise<ScheduleRecord[]>, get(id: string): Promise<ScheduleRecord | null>, save(record: ScheduleRecord): Promise<ScheduleRecord>, remove(id: string): Promise<boolean> }} AsyncScheduleStore
 * @typedef {{ pool?: import('./postgres-schedule-store.js').PgPool | null, connectionString?: string | null, pg?: AsyncScheduleStore | null }} CachedPostgresScheduleStoreOptions
 */

/** 同步外观:对外暴露同步 list/get/save/remove,背后用内存 Map 镜像 + 异步 PG 写穿。 */
export class CachedPostgresScheduleStore {
  /** @param {CachedPostgresScheduleStoreOptions} [options] */
  constructor({ pool = null, connectionString = null, pg = null } = {}) {
    /** @type {AsyncScheduleStore} */
    this._pg = pg || new PostgresScheduleStore({ pool, connectionString });
    /** @type {Map<string, ScheduleRecord>} */
    this._cache = new Map(); // id -> record
    /** @type {boolean} */
    this._hydrated = false;
    /** @type {Promise<void> | null} */
    this._hydrating = null;
    void this.hydrate();
  }

  /** 启动时从 PG 拉全量记录灌入内存缓存(去重、幂等);失败则降级仅用缓存。 @returns {Promise<void>} */
  hydrate() {
    if (this._hydrated) return Promise.resolve();
    if (this._hydrating) return this._hydrating;
    this._hydrating = Promise.resolve(this._pg.list({}))
      .then((rows) => { for (const r of rows || []) this._cache.set(r.id, r); this._hydrated = true; })
      .catch(() => { /* best-effort; serve from cache */ })
      .finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  /** 同步列出缓存中的调度记录,可按租户/用户过滤,按 nextFireAt 升序。 @param {ScheduleListOptions} [options] @returns {ScheduleRecord[]} */
  list({ tenantId, userId } = {}) {
    let out = [...this._cache.values()];
    if (tenantId) out = out.filter((r) => r.tenantId === tenantId);
    if (userId) out = out.filter((r) => r.userId === userId);
    return out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
  }

  /** 同步从缓存取单条调度记录。 @param {string} id @returns {ScheduleRecord | null} */
  get(id) {
    return this._cache.get(id) || null;
  }

  /** 写缓存并异步写穿 PG(失败靠下次 save 重试);同步返回入参记录。 @param {ScheduleRecord} record @returns {ScheduleRecord} */
  save(record) {
    this._cache.set(record.id, record);
    Promise.resolve(this._pg.save(record)).catch(() => { /* cache holds it; PG retried on next save */ });
    return record;
  }

  /** 从缓存删除并异步在 PG 删除;同步返回缓存中是否曾存在。 @param {string} id @returns {boolean} */
  remove(id) {
    const had = this._cache.delete(id);
    Promise.resolve(this._pg.remove(id)).catch(() => {});
    return had;
  }
}

/** 工厂:构造带 PG 写穿的同步调度存储外观。 @param {CachedPostgresScheduleStoreOptions} [options] @returns {CachedPostgresScheduleStore} */
export function createCachedPostgresScheduleStore(options = {}) {
  return new CachedPostgresScheduleStore(options);
}
