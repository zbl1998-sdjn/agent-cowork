// @ts-check
import { nextFireAt, parseCron, describeCron } from './cron.js';
import { createUlid } from './runs-index.js';
import { FileScheduleStore, normaliseTenantId, normaliseUserId } from './scheduler-store.js';

export { FileScheduleStore, SqliteScheduleStore, createScheduleStore } from './scheduler-store.js';

/**
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ScheduleListOptions
 * @typedef {{ id: string, tenantId: string, userId?: string, traceId?: string | null, name: string, kind: string, status: string, cron?: string | null, cronHuman?: string | null, fireAt?: string | null, nextFireAt?: string | null, lastFiredAt?: string | null, lastRunId?: string | null, lastError?: string | null, idempotencyKey?: string | null, payload?: unknown, version?: number, runs?: number, createdAt?: string, updatedAt?: string, [key: string]: unknown }} ScheduleRecord
 * @typedef {{ list(options?: ScheduleListOptions): ScheduleRecord[], get(id: string): ScheduleRecord | null, save(record: ScheduleRecord): ScheduleRecord, remove(id: string): boolean, storeDir?: string }} ScheduleStore
 * @typedef {{ runId?: string | null, id?: string | null, [key: string]: unknown } | null | undefined} SchedulerExecutorResult
 * @typedef {(record: ScheduleRecord) => SchedulerExecutorResult | Promise<SchedulerExecutorResult>} SchedulerExecutor
 * @typedef {(event: string, payload?: Record<string, unknown>) => void} SchedulerLogger
 * @typedef {{ storeDir?: string, store?: ScheduleStore | null, executor: SchedulerExecutor, tickIntervalMs?: number, logger?: SchedulerLogger | null, now?: () => Date }} SchedulerOptions
 * @typedef {{ name?: unknown, cron?: string | null, fireAt?: string | null, payload?: unknown, tenantId?: unknown, userId?: unknown, traceId?: unknown, idempotencyKey?: unknown }} ScheduleCreateInput
 * @typedef {{ ok: true, schedule: ScheduleRecord, result: SchedulerExecutorResult } | { ok: false, schedule: ScheduleRecord, error: unknown }} SchedulerFireResult
 */

/** @param {string} value */
function isPositiveFutureIso(value) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

/** @returns {string} */
function nowIso() {
  return new Date().toISOString();
}

export class Scheduler {
  /** @param {SchedulerOptions} options */
  constructor({ storeDir, store = null, executor, tickIntervalMs = 30_000, logger = null, now = () => new Date() }) {
    if (!store && !storeDir) {
      throw new Error('Scheduler: storeDir or store required');
    }
    if (typeof executor !== 'function') {
      throw new Error('Scheduler: executor must be a function');
    }
    this.store = store || new FileScheduleStore({ storeDir });
    this.storeDir = storeDir || this.store.storeDir || null;
    this.executor = executor;
    this.tickIntervalMs = Math.max(1000, Number(tickIntervalMs) || 30_000);
    this.logger = logger;
    this.now = now;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    this.tickInFlight = false;
  }

  /** @param {ScheduleListOptions} [options] @returns {ScheduleRecord[]} */
  list({ tenantId, userId } = {}) {
    return this.store.list({ tenantId, userId });
  }

  /** @param {string} id @returns {ScheduleRecord | null} */
  get(id) {
    return this.store.get(id);
  }

  /** @param {ScheduleCreateInput} input @returns {ScheduleRecord} */
  create({
    name,
    cron,
    fireAt,
    payload = {},
    tenantId,
    userId,
    traceId,
    idempotencyKey,
  }) {
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
    const next = fireAt ? new Date(fireAt) : nextFireAt(/** @type {string} */ (cron), now);
    const record = {
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

  /** @param {string} id @returns {boolean} */
  cancel(id) {
    const record = this.get(id);
    if (!record) return false;
    record.status = 'cancelled';
    record.updatedAt = nowIso();
    record.version = (record.version || 1) + 1;
    this.store.save(record);
    return true;
  }

  /** @param {string} id @returns {boolean} */
  remove(id) {
    return this.store.remove(id);
  }

  /** @param {ScheduleListOptions | Date} [filterOrAsOf] @param {Date} [maybeAsOf] @returns {ScheduleRecord[]} */
  pickDue(filterOrAsOf = {}, maybeAsOf = this.now()) {
    const filter = filterOrAsOf instanceof Date ? {} : filterOrAsOf;
    const asOf = filterOrAsOf instanceof Date ? filterOrAsOf : maybeAsOf;
    return this.list(filter).filter((record) => {
      if (record.status !== 'pending') return false;
      if (!record.nextFireAt) return false;
      return Date.parse(record.nextFireAt) <= asOf.getTime();
    });
  }

  /** @param {ScheduleRecord} record @returns {Promise<SchedulerFireResult>} */
  async _fireOne(record) {
    const startedAt = this.now();
    try {
      const result = await this.executor(record);
      const lastRunId = result?.runId || result?.id || null;
      const next = record.kind === 'one-shot' ? null : nextFireAt(/** @type {string} */ (record.cron), startedAt);
      const updated = {
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
      const next = record.kind === 'one-shot' ? null : nextFireAt(/** @type {string} */ (record.cron), startedAt);
      const updated = {
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

  /** @param {ScheduleListOptions} [filter] @returns {Promise<SchedulerFireResult[]>} */
  async tickOnce(filter = {}) {
    if (this.tickInFlight) return [];
    this.tickInFlight = true;
    try {
      const due = this.pickDue(filter);
      const results = [];
      for (const record of due) {
        results.push(await this._fireOne(record));
      }
      return results;
    } finally {
      this.tickInFlight = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tickOnce().catch(() => {});
    }, this.tickIntervalMs);
    const timer = /** @type {ReturnType<typeof setInterval> & { unref?: () => void }} */ (this.timer);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
