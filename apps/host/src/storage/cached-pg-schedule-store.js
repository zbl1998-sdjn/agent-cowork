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

  /** @returns {Promise<void>} */
  hydrate() {
    if (this._hydrated) return Promise.resolve();
    if (this._hydrating) return this._hydrating;
    this._hydrating = Promise.resolve(this._pg.list({}))
      .then((rows) => { for (const r of rows || []) this._cache.set(r.id, r); this._hydrated = true; })
      .catch(() => { /* best-effort; serve from cache */ })
      .finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  /** @param {ScheduleListOptions} [options] @returns {ScheduleRecord[]} */
  list({ tenantId, userId } = {}) {
    let out = [...this._cache.values()];
    if (tenantId) out = out.filter((r) => r.tenantId === tenantId);
    if (userId) out = out.filter((r) => r.userId === userId);
    return out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
  }

  /** @param {string} id @returns {ScheduleRecord | null} */
  get(id) {
    return this._cache.get(id) || null;
  }

  /** @param {ScheduleRecord} record @returns {ScheduleRecord} */
  save(record) {
    this._cache.set(record.id, record);
    Promise.resolve(this._pg.save(record)).catch(() => { /* cache holds it; PG retried on next save */ });
    return record;
  }

  /** @param {string} id @returns {boolean} */
  remove(id) {
    const had = this._cache.delete(id);
    Promise.resolve(this._pg.remove(id)).catch(() => {});
    return had;
  }
}

/** @param {CachedPostgresScheduleStoreOptions} [options] @returns {CachedPostgresScheduleStore} */
export function createCachedPostgresScheduleStore(options = {}) {
  return new CachedPostgresScheduleStore(options);
}
