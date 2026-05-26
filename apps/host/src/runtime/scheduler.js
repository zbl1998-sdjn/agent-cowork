import { nextFireAt, parseCron, describeCron } from './cron.js';
import { createUlid } from './runs-index.js';
import { FileScheduleStore, normaliseTenantId, normaliseUserId } from './scheduler-store.js';

export { FileScheduleStore, SqliteScheduleStore, createScheduleStore } from './scheduler-store.js';

function isPositiveFutureIso(value) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

export class Scheduler {
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
    this.timer = null;
    this.tickInFlight = false;
  }

  list({ tenantId, userId } = {}) {
    return this.store.list({ tenantId, userId });
  }

  get(id) {
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
    const next = fireAt ? new Date(fireAt) : nextFireAt(cron, now);
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

  cancel(id) {
    const record = this.get(id);
    if (!record) return false;
    record.status = 'cancelled';
    record.updatedAt = nowIso();
    record.version = (record.version || 1) + 1;
    this.store.save(record);
    return true;
  }

  remove(id) {
    return this.store.remove(id);
  }

  pickDue(filterOrAsOf = {}, maybeAsOf = this.now()) {
    const filter = filterOrAsOf instanceof Date ? {} : filterOrAsOf;
    const asOf = filterOrAsOf instanceof Date ? filterOrAsOf : maybeAsOf;
    return this.list(filter).filter((record) => {
      if (record.status !== 'pending') return false;
      if (!record.nextFireAt) return false;
      return Date.parse(record.nextFireAt) <= asOf.getTime();
    });
  }

  async _fireOne(record) {
    const startedAt = this.now();
    try {
      const result = await this.executor(record);
      const lastRunId = result?.runId || result?.id || null;
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron, startedAt);
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
      const next = record.kind === 'one-shot' ? null : nextFireAt(record.cron, startedAt);
      const updated = {
        ...record,
        status: record.kind === 'one-shot' ? 'failed' : 'pending',
        nextFireAt: next ? next.toISOString() : null,
        lastFiredAt: startedAt.toISOString(),
        lastError: String(err && err.message ? err.message : err).slice(0, 1024),
        runs: (Number(record.runs) || 0) + 1,
        updatedAt: nowIso(),
        version: (Number(record.version) || 1) + 1,
      };
      this.store.save(updated);
      if (this.logger) {
        this.logger('scheduler.fire_failed', { id: record.id, error: err?.message });
      }
      return { ok: false, schedule: updated, error: err };
    }
  }

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
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
