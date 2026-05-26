// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDatabase } from '../storage/sqlite.js';

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * @typedef {{ get(...params: unknown[]): unknown, run(...params: unknown[]): { changes?: number }, all(...params: unknown[]): unknown[] }} SqliteStatement
 * @typedef {{ prepare(sql: string): SqliteStatement }} SqliteDatabase
 * @typedef {{ id: string, tenantId: string, userId?: string, traceId?: string, name: string, kind: string, status: string, cron?: string | null, fireAt?: string | null, nextFireAt?: string | null, lastFiredAt?: string | null, lastRunId?: string | null, version?: number, runs?: number, createdAt?: string, updatedAt?: string, [key: string]: unknown }} ScheduleRecord
 * @typedef {{ storeDir?: string }} FileScheduleStoreOptions
 * @typedef {{ dbPath?: string, db?: SqliteDatabase | null }} SqliteScheduleStoreOptions
 * @typedef {{ backend?: string, storeDir?: string, dbPath?: string, db?: SqliteDatabase | null }} CreateScheduleStoreOptions
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ScheduleListOptions
 * @typedef {{ schedule_json: string }} ScheduleRow
 */

/** @param {string} dir @returns {string} */
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** @param {unknown} value @param {number} maxLength @returns {string} */
function clampString(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/** @param {unknown} value @returns {string} */
export function normaliseTenantId(value) {
  return clampString(value || 'tenant_local', 96).trim() || 'tenant_local';
}

/** @param {unknown} value @returns {string} */
export function normaliseUserId(value) {
  return clampString(value || 'user_local', 96).trim() || 'user_local';
}

/** @param {string} file @returns {ScheduleRecord | null} */
function readScheduleFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return /** @type {ScheduleRecord} */ (JSON.parse(raw));
  } catch {
    return null;
  }
}

export class FileScheduleStore {
  /** @param {FileScheduleStoreOptions} [options] */
  constructor({ storeDir } = {}) {
    if (!storeDir) {
      throw new Error('FileScheduleStore: storeDir required');
    }
    this.storeDir = storeDir;
    ensureDirSync(this.storeDir);
  }

  /** @param {string} id @returns {string} */
  _file(id) {
    if (!SCHEDULE_ID_RE.test(id)) {
      throw new Error('Scheduler: invalid schedule id');
    }
    return path.join(this.storeDir, `${id}.json`);
  }

  /** @param {ScheduleListOptions} [options] @returns {ScheduleRecord[]} */
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

  /** @param {string} id @returns {ScheduleRecord | null} */
  get(id) {
    return readScheduleFile(this._file(id));
  }

  /** @param {ScheduleRecord} record @returns {ScheduleRecord} */
  save(record) {
    fs.writeFileSync(this._file(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  /** @param {string} id @returns {boolean} */
  remove(id) {
    const file = this._file(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}

export class SqliteScheduleStore {
  /** @param {SqliteScheduleStoreOptions} [options] */
  constructor({ dbPath, db = null } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteScheduleStore: dbPath is required');
    }
    this.db = db || createSqliteDatabase(/** @type {string} */ (dbPath));
  }

  /** @param {ScheduleListOptions} [options] @returns {ScheduleRecord[]} */
  list({ tenantId, userId } = {}) {
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
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
    return rows.map((row) => /** @type {ScheduleRecord} */ (JSON.parse(/** @type {ScheduleRow} */ (row).schedule_json)));
  }

  /** @param {string} id @returns {ScheduleRecord | null} */
  get(id) {
    const row = /** @type {ScheduleRow | null | undefined} */ (this.db
      .prepare('SELECT schedule_json FROM schedules WHERE id = ?')
      .get(id));
    return row ? /** @type {ScheduleRecord} */ (JSON.parse(row.schedule_json)) : null;
  }

  /** @param {ScheduleRecord} record @returns {ScheduleRecord} */
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

  /** @param {string} id @returns {boolean} */
  remove(id) {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}

/** @param {CreateScheduleStoreOptions} [options] */
export function createScheduleStore({ backend = 'file', storeDir, dbPath, db } = {}) {
  if (backend === 'sqlite') {
    return new SqliteScheduleStore({ dbPath, db });
  }
  return new FileScheduleStore({ storeDir });
}
