// 调度存储(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:计划任务(日程)的持久化——文件后端 FileScheduleStore 与 SQLite 后端 SqliteScheduleStore 同接口
//       (端口与适配器),按 tenant/user 隔离地增删查日程记录。依赖:storage/sqlite + node:fs/path。
// 导出:FileScheduleStore / SqliteScheduleStore / createScheduleStore + tenant/user 归一化。
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDatabase, type SqliteDatabase } from '../storage/sqlite.js';

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

export type ScheduleRecord = {
  id: string;
  tenantId: string;
  userId?: string;
  traceId?: string | null;
  name: string;
  kind: string;
  status: string;
  cron?: string | null;
  cronHuman?: string | null;
  fireAt?: string | null;
  nextFireAt?: string | null;
  lastFiredAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
  idempotencyKey?: string | null;
  payload?: unknown;
  version?: number;
  runs?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};
export type FileScheduleStoreOptions = { storeDir?: string };
export type SqliteScheduleStoreOptions = { dbPath?: string; db?: SqliteDatabase | null };
export type CreateScheduleStoreOptions = {
  backend?: string;
  storeDir?: string;
  dbPath?: string;
  db?: SqliteDatabase | null;
};
export type ScheduleListOptions = { tenantId?: unknown; userId?: unknown };
type ScheduleRow = { schedule_json: string };

function ensureDirSync(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clampString(value: unknown, maxLength: number): string {
  const text = String(value || '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function normaliseTenantId(value: unknown): string {
  return clampString(value || 'tenant_local', 96).trim() || 'tenant_local';
}

export function normaliseUserId(value: unknown): string {
  return clampString(value || 'user_local', 96).trim() || 'user_local';
}

function readScheduleFile(file: string): ScheduleRecord | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as ScheduleRecord;
  } catch {
    return null;
  }
}

export class FileScheduleStore {
  readonly storeDir: string;

  constructor({ storeDir }: FileScheduleStoreOptions = {}) {
    if (!storeDir) {
      throw new Error('FileScheduleStore: storeDir required');
    }
    this.storeDir = storeDir;
    ensureDirSync(this.storeDir);
  }

  _file(id: string): string {
    if (!SCHEDULE_ID_RE.test(id)) {
      throw new Error('Scheduler: invalid schedule id');
    }
    return path.join(this.storeDir, `${id}.json`);
  }

  list({ tenantId, userId }: ScheduleListOptions = {}): ScheduleRecord[] {
    if (!fs.existsSync(this.storeDir)) {
      return [];
    }
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    const wantUser = userId ? normaliseUserId(userId) : null;
    const out: ScheduleRecord[] = [];
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

  get(id: string): ScheduleRecord | null {
    return readScheduleFile(this._file(id));
  }

  save(record: ScheduleRecord): ScheduleRecord {
    fs.writeFileSync(this._file(record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  remove(id: string): boolean {
    const file = this._file(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}

export class SqliteScheduleStore {
  readonly db: SqliteDatabase;

  constructor({ dbPath, db = null }: SqliteScheduleStoreOptions = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteScheduleStore: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath as string);
  }

  list({ tenantId, userId }: ScheduleListOptions = {}): ScheduleRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
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
    return rows.map((row) => JSON.parse((row as ScheduleRow).schedule_json) as ScheduleRecord);
  }

  get(id: string): ScheduleRecord | null {
    const row = this.db
      .prepare('SELECT schedule_json FROM schedules WHERE id = ?')
      .get(id) as ScheduleRow | null | undefined;
    return row ? JSON.parse(row.schedule_json) as ScheduleRecord : null;
  }

  save(record: ScheduleRecord): ScheduleRecord {
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

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}

export function createScheduleStore({
  backend = 'file',
  storeDir,
  dbPath,
  db,
}: CreateScheduleStoreOptions = {}): FileScheduleStore | SqliteScheduleStore {
  if (backend === 'sqlite') {
    return new SqliteScheduleStore({ dbPath, db });
  }
  return new FileScheduleStore({ storeDir });
}
