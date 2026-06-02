// 调度器(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:管理计划任务(cron 周期 / 定时 fireAt):创建/列出/删除日程,按 tick 到点触发注入的 executor
//       (通常是跑配方),记录上次/下次触发与错误。多租户隔离,幂等键防重复触发。
// 依赖:同层 cron(解析/算下次)、runs-index(ULID)、scheduler-store(持久化)。导出:Scheduler 及存储转出。
import { nextFireAt, parseCron, describeCron } from './cron.js';
import { omitUndefined } from '../util/object.js';
import { createUlid } from './runs-index.js';
import {
  FileScheduleStore,
  normaliseTenantId,
  normaliseUserId,
  type ScheduleListOptions,
  type ScheduleRecord,
} from './scheduler-store.js';

export { FileScheduleStore, SqliteScheduleStore, createScheduleStore } from './scheduler-store.js';
export type { ScheduleListOptions, ScheduleRecord } from './scheduler-store.js';

export type ScheduleStore = {
  list(options?: ScheduleListOptions): ScheduleRecord[];
  get(id: string): ScheduleRecord | null;
  save(record: ScheduleRecord): ScheduleRecord;
  remove(id: string): boolean;
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
export type ScheduleCreateInput = {
  name?: unknown;
  cron?: string | null;
  fireAt?: string | null;
  payload?: unknown;
  tenantId?: unknown;
  userId?: unknown;
  traceId?: unknown;
  idempotencyKey?: unknown;
};
export type SchedulerFireResult =
  | { ok: true; schedule: ScheduleRecord; result: SchedulerExecutorResult }
  | { ok: false; schedule: ScheduleRecord; error: unknown };

function isPositiveFutureIso(value: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

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

  list({ tenantId, userId }: ScheduleListOptions = {}): ScheduleRecord[] {
    return this.store.list(omitUndefined({ tenantId, userId }));
  }

  get(id: string): ScheduleRecord | null {
    return this.store.get(id);
  }

  create({
    name,
    cron,
    fireAt,
    payload = {},
    tenantId,
    userId,
    traceId,
    idempotencyKey,
  }: ScheduleCreateInput): ScheduleRecord {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Scheduler: name is required');
    }
    if (!cron && !fireAt) {
      throw new Error('Scheduler: cron or fireAt is required');
    }
    if (cron) {
      parseCron(cron);
    }
    if (fireAt && !isPositiveFutureIso(fireAt)) {
      throw new Error('Scheduler: fireAt must be a future ISO timestamp');
    }
    const id = createUlid().replace(/^run_/, 'sched_');
    const now = this.now();
    const next = fireAt ? new Date(fireAt) : nextFireAt(cron as string, now);
    const record: ScheduleRecord = {
      id,
      version: 1,
      name: name.trim().slice(0, 200),
      kind: fireAt ? 'one-shot' : 'cron',
      cron: cron || null,
      cronHuman: cron ? describeCron(cron) : null,
      fireAt: fireAt || null,
      payload,
      tenantId: normaliseTenantId(tenantId),
      userId: normaliseUserId(userId),
      traceId: traceId ? String(traceId).slice(0, 96) : null,
      idempotencyKey: idempotencyKey ? String(idempotencyKey).slice(0, 96) : null,
      status: 'pending',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextFireAt: next.toISOString(),
      lastFiredAt: null,
      lastRunId: null,
      lastError: null,
      runs: 0,
    };
    this.store.save(record);
    return record;
  }

  cancel(id: string): boolean {
    const record = this.get(id);
    if (!record) return false;
    record.status = 'cancelled';
    record.updatedAt = nowIso();
    record.version = (record.version || 1) + 1;
    this.store.save(record);
    return true;
  }

  remove(id: string): boolean {
    return this.store.remove(id);
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
      const lastRunId = result?.runId || result?.id || null;
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron as string, startedAt);
      const updated: ScheduleRecord = {
        ...record,
        status: record.kind === 'one-shot' ? 'completed' : 'pending',
        nextFireAt: next ? next.toISOString() : null,
        lastFiredAt: startedAt.toISOString(),
        lastRunId,
        lastError: null,
        runs: (Number(record.runs) || 0) + 1,
        updatedAt: nowIso(),
        version: (Number(record.version) || 1) + 1,
      };
      this.store.save(updated);
      return { ok: true, schedule: updated, result };
    } catch (err) {
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron as string, startedAt);
      const updated: ScheduleRecord = {
        ...record,
        status: record.kind === 'one-shot' ? 'failed' : 'pending',
        nextFireAt: next ? next.toISOString() : null,
        lastFiredAt: startedAt.toISOString(),
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1024),
        runs: (Number(record.runs) || 0) + 1,
        updatedAt: nowIso(),
        version: (Number(record.version) || 1) + 1,
      };
      this.store.save(updated);
      if (this.logger) {
        this.logger('scheduler.fire_failed', { id: record.id, error: err instanceof Error ? err.message : String(err) });
      }
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
      this.tickOnce().catch(() => undefined);
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
