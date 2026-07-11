// 调度存储的同步外观:内存镜像 + 异步 Postgres 写穿(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:为同步读写的 Scheduler 运行时包装异步 PostgresScheduleStore——启动时从 PG
//       水合到内存 Map,list/get 走内存,save/remove 写内存并异步写穿 PG。
// 依赖:同层 postgres-schedule-store(L1)。后端:PostgreSQL(经其适配)。
// 导出:CachedPostgresScheduleStore(类) · createCachedPostgresScheduleStore(工厂)。
import { PostgresScheduleStore } from './postgres-schedule-store.js';
import {
  canonicalIdentityFilter,
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';
import type { PgPool, ScheduleListOptions, ScheduleRecord } from './postgres-schedule-store.js';

type AsyncScheduleStore = {
  list(options?: ScheduleListOptions): Promise<ScheduleRecord[]>;
  get(id: string, options?: ScheduleListOptions): Promise<ScheduleRecord | null>;
  save(record: ScheduleRecord): Promise<ScheduleRecord>;
  remove(id: string, options?: ScheduleListOptions): Promise<boolean>;
};
export type CachedPostgresScheduleStoreOptions = {
  pool?: PgPool | null;
  connectionString?: string | null;
  pg?: AsyncScheduleStore | null;
  onBackgroundError?: ScheduleBackgroundErrorReporter | null;
};
export type ScheduleBackgroundErrorEvent = Readonly<{
  operation: 'hydrate' | 'save' | 'remove';
  recordId?: string;
}>;
export type ScheduleBackgroundErrorReporter = (
  event: ScheduleBackgroundErrorEvent,
) => unknown | Promise<unknown>;

function matchesScope(record: ScheduleRecord, options: ScheduleListOptions = {}): boolean {
  const { tenantId, userId } = canonicalIdentityFilter(options);
  const owner = canonicalRequiredIdentityScope(record.tenantId, record.userId);
  if (!owner) return false;
  if (tenantId && owner.tenantId !== tenantId) return false;
  if (userId && owner.userId !== userId) return false;
  return true;
}

/** 同步外观:对外暴露同步 list/get/save/remove,背后用内存 Map 镜像 + 异步 PG 写穿。 */
export class CachedPostgresScheduleStore {
  private _pg: AsyncScheduleStore;
  private _cache: Map<string, ScheduleRecord>;
  private _hydrated: boolean;
  private _hydrating: Promise<void> | null;
  private _onBackgroundError: ScheduleBackgroundErrorReporter | null;

  constructor({
    pool = null,
    connectionString = null,
    pg = null,
    onBackgroundError = null,
  }: CachedPostgresScheduleStoreOptions = {}) {
    this._pg = pg || new PostgresScheduleStore({ pool, connectionString });
    this._cache = new Map(); // id -> record。
    this._hydrated = false;
    this._hydrating = null;
    this._onBackgroundError = onBackgroundError;
    void this.hydrate().catch(() => this._reportBackgroundError({ operation: 'hydrate' }));
  }

  private _reportBackgroundError(event: ScheduleBackgroundErrorEvent): void {
    if (!this._onBackgroundError) return;
    try {
      Promise.resolve(this._onBackgroundError(event)).catch(() => undefined);
    } catch {
      // Reporting must never turn one background persistence failure into another.
    }
  }

  /** 启动时从 PG 拉全量记录灌入内存缓存(去重、幂等);显式调用时失败可见。 */
  hydrate(): Promise<void> {
    if (this._hydrated) return Promise.resolve();
    if (this._hydrating) return this._hydrating;
    this._hydrating = Promise.resolve()
      .then(() => this._pg.list({}))
      .then((rows) => {
        for (const record of rows || []) {
          if (canonicalRequiredIdentityScope(record.tenantId, record.userId)) {
            this._cache.set(record.id, record);
          }
        }
        this._hydrated = true;
      })
      .finally(() => { this._hydrating = null; });
    return this._hydrating;
  }

  /** 同步列出缓存中的调度记录,可按租户/用户过滤,按 nextFireAt 升序。 */
  list(options: ScheduleListOptions = {}): ScheduleRecord[] {
    canonicalIdentityFilter(options);
    const out = [...this._cache.values()].filter((record) => matchesScope(record, options));
    return out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
  }

  /** 同步从缓存按 id 与可选 owner scope 取单条调度记录。 */
  get(id: string, options: ScheduleListOptions = {}): ScheduleRecord | null {
    const record = this._cache.get(id);
    return record && matchesScope(record, options) ? record : null;
  }

  /** 写缓存并异步写穿 PG(失败靠下次 save 重试);同步返回入参记录。 */
  save(record: ScheduleRecord): ScheduleRecord {
    requireIdentityScopeFrom(record, { label: 'schedule record identity' });
    this._cache.set(record.id, record);
    Promise.resolve()
      .then(() => this._pg.save(record))
      .catch(() => this._reportBackgroundError({ operation: 'save', recordId: record.id }));
    return record;
  }

  /** 从缓存按 owner scope 删除并异步在 PG 删除;越权时不产生副作用。 */
  remove(id: string, options: ScheduleListOptions = {}): boolean {
    canonicalIdentityFilter(options);
    const record = this._cache.get(id);
    if (!record || !matchesScope(record, options)) return false;
    const had = this._cache.delete(id);
    Promise.resolve()
      .then(() => this._pg.remove(id, options))
      .catch(() => this._reportBackgroundError({ operation: 'remove', recordId: id }));
    return had;
  }
}

/** 工厂:构造带 PG 写穿的同步调度存储外观。 */
export function createCachedPostgresScheduleStore(options: CachedPostgresScheduleStoreOptions = {}): CachedPostgresScheduleStore {
  return new CachedPostgresScheduleStore(options);
}
