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

export class CachedPostgresScheduleStore {
  constructor({ pool = null, connectionString = null, pg = null } = {}) {
    this._pg = pg || new PostgresScheduleStore({ pool, connectionString });
    this._cache = new Map(); // id -> record
    this._hydrated = false;
    this._hydrating = null;
    void this.hydrate();
  }

  hydrate() {
    if (this._hydrated) return Promise.resolve();
    if (this._hydrating) return this._hydrating;
    this._hydrating = Promise.resolve(this._pg.list({}))
      .then((rows) => { for (const r of rows || []) this._cache.set(r.id, r); this._hydrated = true; })
      .catch(() => { /* best-effort; serve from cache */ })
      .finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  list({ tenantId, userId } = {}) {
    let out = [...this._cache.values()];
    if (tenantId) out = out.filter((r) => r.tenantId === tenantId);
    if (userId) out = out.filter((r) => r.userId === userId);
    return out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
  }

  get(id) {
    return this._cache.get(id) || null;
  }

  save(record) {
    this._cache.set(record.id, record);
    Promise.resolve(this._pg.save(record)).catch(() => { /* cache holds it; PG retried on next save */ });
    return record;
  }

  remove(id) {
    const had = this._cache.delete(id);
    Promise.resolve(this._pg.remove(id)).catch(() => {});
    return had;
  }
}

export function createCachedPostgresScheduleStore(options = {}) {
  return new CachedPostgresScheduleStore(options);
}
