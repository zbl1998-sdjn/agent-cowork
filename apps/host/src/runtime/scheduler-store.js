import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDatabase } from '../storage/sqlite.js';

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clampString(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function normaliseTenantId(value) {
  return clampString(value || 'tenant_local', 96).trim() || 'tenant_local';
}

export function normaliseUserId(value) {
  return clampString(value || 'user_local', 96).trim() || 'user_local';
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
