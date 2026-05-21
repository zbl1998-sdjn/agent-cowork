import fs from 'node:fs';
import path from 'node:path';
import { nextFireAt, parseCron, describeCron } from './cron.js';
import { createUlid } from './runs-index.js';
import { createSqliteDatabase } from '../storage/sqlite.js';

// File-backed scheduler. Stores schedules as JSON files under a directory,
// runs a low-frequency tick (every 30s by default), and fires due jobs by
// invoking a caller-supplied executor with the schedule record.
//
// Scale-readiness note: this is the Phase A adapter. Phase B will replace
// the file store with Postgres + Redis lock, and the executor with a queue
// (NATS/Temporal). The Schedule shape (tenantId/userId/traceId/version/
// idempotency) is forward-compatible.

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clampString(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normaliseTenantId(value) {
  return clampString(value || 'tenant_local', 96).trim() || 'tenant_local';
}

function normaliseUserId(value) {
  return clampString(value || 'user_local', 96).trim() || 'user_local';
}

function isPositiveFutureIso(value) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function readScheduleFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class FileScheduleStore {
  constructor({ storeDir } = {}) {
    if (!storeDir) {
      throw new Error('FileScheduleStore: storeDir required');
    }
    this.storeDir = storeDir;
    ensureDirSync(this.storeDir);
  }

  _file(id) {
    if (!SCHEDULE_ID_RE.test(id)) {
      throw new Error('Scheduler: invalid schedule id');
    }
    return path.join(this.storeDir, `${id}.json`);
  }

  list({ tenantId, userId } = {}) {
    if (!fs.existsSync(this.storeDir)) {
      return [];
    }
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    const wantUser = userId ? normaliseUserId(userId) : null;
    const out = [];
    for (const name of fs.readdirSync(this.storeDir)) {
      if (!name.endsWith('.json')) continue;
      const record = readScheduleFile(path.join(this.storeDir, name));
      if (!record) continue;
      if (wantTenant && record.tenantId !== wantTenant) continue;
      if (wantUser && record.userId !== wantUser) continue;
      out.push(record);
    }
    out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
    return out;
  }

  get(id) {
    return readScheduleFile(this._file(id));
  }

  save(record) {
    fs.writeFileSync(this._file(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  remove(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}

export class SqliteScheduleStore {
  constructor({ dbPath, db = null } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteScheduleStore: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath);
  }

  list({ tenantId, userId } = {}) {
    const where = [];
    const params = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(normaliseTenantId(tenantId));
    }
    if (userId) {
      where.push('user_id = ?');
      params.push(normaliseUserId(userId));
    }
    const rows = this.db.prepare(`
      SELECT schedule_json
      FROM schedules
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(next_fire_at, '')
    `).all(...params);
    return rows.map((row) => JSON.parse(row.schedule_json));
  }

  get(id) {
    const row = this.db
      .prepare('SELECT schedule_json FROM schedules WHERE id = ?')
      .get(id);
    return row ? JSON.parse(row.schedule_json) : null;
  }

  save(record) {
    this.db.prepare(`
      INSERT INTO schedules (
        id, tenant_id, user_id, trace_id, name, kind, status, cron, fire_at,
        next_fire_at, last_fired_at, last_run_id, version, runs,
        created_at, updated_at, schedule_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        trace_id = excluded.trace_id,
        name = excluded.name,
        kind = excluded.kind,
        status = excluded.status,
        cron = excluded.cron,
        fire_at = excluded.fire_at,
        next_fire_at = excluded.next_fire_at,
        last_fired_at = excluded.last_fired_at,
        last_run_id = excluded.last_run_id,
        version = excluded.version,
        runs = excluded.runs,
        updated_at = excluded.updated_at,
        schedule_json = excluded.schedule_json
    `).run(
      record.id,
      record.tenantId,
      record.userId,
      record.traceId,
      record.name,
      record.kind,
      record.status,
      record.cron,
      record.fireAt,
      record.nextFireAt,
      record.lastFiredAt,
      record.lastRunId,
      Number(record.version) || 1,
      Number(record.runs) || 0,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record),
    );
    return record;
  }

  remove(id) {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}

export function createScheduleStore({ backend = 'file', storeDir, dbPath, db } = {}) {
  if (backend === 'sqlite') {
    return new SqliteScheduleStore({ dbPath, db });
  }
  return new FileScheduleStore({ storeDir });
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
      // Validate.
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
      const next = record.kind === 'one-shot'
        ? null
        : nextFireAt(record.cron, startedAt);
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
      const next = record.kind === 'one-shot'
        ? null
        : nextFireAt(record.cron, startedAt);
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
