// 调度器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:管理计划任务(cron 周期 / 定时 fireAt):创建/列出/删除日程,按 tick 到点触发注入的 executor
//       (通常是跑配方),记录上次/下次触发与错误。多租户隔离,幂等键防重复触发。
// 依赖:同层 cron(解析/算下次)、runs-index(ULID)、scheduler-store(持久化)。导出:Scheduler 及存储转出。
import { nextFireAt } from './cron.js';
import { omitUndefined } from '../util/object.js';
import {
  canonicalIdentityFilter,
  canonicalRequiredIdentityScope,
} from '../security/identity-scope.js';
import {
  FileScheduleStore,
  type ScheduleListOptions,
  type ScheduleRecord,
} from './scheduler-store.js';
import {
  appendScheduleAttempt,
  createScheduleAttempt,
  createSchedulerRecord,
  normaliseScheduleRecordAttempts,
  type ScheduleCreateInput,
} from './scheduler-records.js';

export { FileScheduleStore, SqliteScheduleStore, createScheduleStore } from './scheduler-store.js';
export type { ScheduleListOptions, ScheduleRecord } from './scheduler-store.js';
export type { ScheduleCreateInput } from './scheduler-records.js';

export type ScheduleStore = {
  list(options?: ScheduleListOptions): ScheduleRecord[];
  get(id: string, options?: ScheduleListOptions): ScheduleRecord | null;
  save(record: ScheduleRecord): ScheduleRecord;
  remove(id: string, options?: ScheduleListOptions): boolean;
  storeDir?: string;
};
export type SchedulerExecutorResult = { runId?: string | null; id?: string | null; [key: string]: unknown } | null | undefined;
export type SchedulerExecutor = (record: ScheduleRecord) => SchedulerExecutorResult | Promise<SchedulerExecutorResult>;
export type SchedulerLogger = (event: string, payload?: Record<string, unknown>) => void;
export type SchedulerOptions = {
  storeDir?: string;
  store?: ScheduleStore | null;
  executor: SchedulerExecutor;
  tickIntervalMs?: number;
  logger?: SchedulerLogger | null;
  now?: () => Date;
};
export type SchedulerFireResult =
  | { ok: true; schedule: ScheduleRecord; result: SchedulerExecutorResult }
  | { ok: false; schedule: ScheduleRecord; error: unknown };

function nowIso(): string {
  return new Date().toISOString();
}

export class Scheduler {
  readonly store: ScheduleStore;
  readonly storeDir: string | null;
  readonly executor: SchedulerExecutor;
  readonly tickIntervalMs: number;
  readonly logger: SchedulerLogger | null;
  readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null;
  private tickInFlight: boolean;

  constructor({ storeDir, store = null, executor, tickIntervalMs = 30_000, logger = null, now = () => new Date() }: SchedulerOptions) {
    if (!store && !storeDir) {
      throw new Error('Scheduler: storeDir or store required');
    }
    if (typeof executor !== 'function') {
      throw new Error('Scheduler: executor must be a function');
    }
    this.store = store || new FileScheduleStore(omitUndefined({ storeDir }));
    this.storeDir = storeDir || this.store.storeDir || null;
    this.executor = executor;
    this.tickIntervalMs = Math.max(1000, Number(tickIntervalMs) || 30_000);
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.tickInFlight = false;
  }

  private _safeLog(event: string, payload?: Record<string, unknown>): void {
    if (!this.logger) return;
    try {
      this.logger(event, payload);
    } catch {
      // Diagnostics must never disrupt the scheduler.
    }
  }

  list(options: ScheduleListOptions = {}): ScheduleRecord[] {
    canonicalIdentityFilter(options);
    const records: ScheduleRecord[] = [];
    for (const record of this.store.list(options)) {
      const normalised = normaliseScheduleRecordAttempts(record);
      if (!normalised || !canonicalRequiredIdentityScope(normalised.tenantId, normalised.userId)) continue;
      records.push(normalised);
    }
    return records;
  }

  get(id: string, options: ScheduleListOptions = {}): ScheduleRecord | null {
    canonicalIdentityFilter(options);
    const record = this.store.get(id, options);
    if (!record) return null;
    const normalised = normaliseScheduleRecordAttempts(record);
    return normalised && canonicalRequiredIdentityScope(normalised.tenantId, normalised.userId)
      ? normalised
      : null;
  }

  create(input: ScheduleCreateInput): ScheduleRecord {
    const now = this.now();
    const record = createSchedulerRecord(input, now);
    this.store.save(record);
    return record;
  }

  cancel(id: string, options: ScheduleListOptions = {}): boolean {
    const record = this.get(id, options);
    if (!record) return false;
    record.status = 'cancelled';
    record.updatedAt = nowIso();
    record.version = (record.version || 1) + 1;
    this.store.save(record);
    return true;
  }

  remove(id: string, options: ScheduleListOptions = {}): boolean {
    return this.store.remove(id, options);
  }

  pickDue(filterOrAsOf: ScheduleListOptions | Date = {}, maybeAsOf: Date = this.now()): ScheduleRecord[] {
    const filter = filterOrAsOf instanceof Date ? {} : filterOrAsOf;
    const asOf = filterOrAsOf instanceof Date ? filterOrAsOf : maybeAsOf;
    return this.list(filter).filter((record) => {
      if (record.status !== 'pending') return false;
      if (!record.nextFireAt) return false;
      return Date.parse(record.nextFireAt) <= asOf.getTime();
    });
  }

  async _fireOne(record: ScheduleRecord): Promise<SchedulerFireResult> {
    const startedAt = this.now();
    try {
      const result = await this.executor(record);
      const finishedAt = this.now();
      const runId = result?.runId || result?.id || null;
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron as string, startedAt);
      const updated: ScheduleRecord = {
        ...record,
        status: record.kind === 'one-shot' ? 'completed' : 'pending',
        nextFireAt: next ? next.toISOString() : null,
        lastFiredAt: startedAt.toISOString(),
        lastRunId: runId || record.lastRunId || null,
        lastError: null,
        runs: (Number(record.runs) || 0) + 1,
        attempts: appendScheduleAttempt(record, createScheduleAttempt({
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          status: 'succeeded',
          runId,
          error: null,
          trigger: 'scheduled',
        })),
        updatedAt: finishedAt.toISOString(),
        version: (Number(record.version) || 1) + 1,
      };
      this.store.save(updated);
      return { ok: true, schedule: updated, result };
    } catch (err) {
      const finishedAt = this.now();
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 1024)
        || 'Scheduler executor failed';
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron as string, startedAt);
      const updated: ScheduleRecord = {
        ...record,
        status: record.kind === 'one-shot' ? 'failed' : 'pending',
        nextFireAt: next ? next.toISOString() : null,
        lastFiredAt: startedAt.toISOString(),
        lastRunId: record.lastRunId || null,
        lastError: error,
        runs: (Number(record.runs) || 0) + 1,
        attempts: appendScheduleAttempt(record, createScheduleAttempt({
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          status: 'failed',
          runId: null,
          error,
          trigger: 'scheduled',
        })),
        updatedAt: finishedAt.toISOString(),
        version: (Number(record.version) || 1) + 1,
      };
      this.store.save(updated);
      this._safeLog('scheduler.fire_failed', { id: record.id, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, schedule: updated, error: err };
    }
  }

  async tickOnce(filter: ScheduleListOptions = {}): Promise<SchedulerFireResult[]> {
    if (this.tickInFlight) return [];
    this.tickInFlight = true;
    try {
      const due = this.pickDue(filter);
      const results: SchedulerFireResult[] = [];
      for (const record of due) {
        results.push(await this._fireOne(record));
      }
      return results;
    } finally {
      this.tickInFlight = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickOnce().catch(() => this._safeLog('scheduler.tick_failed'));
    }, this.tickIntervalMs);
    const timer = this.timer as ReturnType<typeof setInterval> & { unref?: () => void };
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
