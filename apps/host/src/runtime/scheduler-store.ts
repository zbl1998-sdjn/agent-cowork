// 调度存储(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:计划任务(日程)的持久化——文件后端 FileScheduleStore 与 SQLite 后端 SqliteScheduleStore 同接口
//       (端口与适配器),按 tenant/user 隔离地增删查日程记录。依赖:storage/sqlite + node:fs/path。
// 导出:FileScheduleStore / SqliteScheduleStore / createScheduleStore + tenant/user 归一化。
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDatabase, type SqliteDatabase } from '../storage/sqlite.js';
import { canonicalIdentityFilter, requireIdentityScopeFrom } from '../security/identity-scope.js';
import { writePrivateFileAtomically } from '../security/private-atomic-file.js';
import {
  createManagedDirectoryBoundary,
  type ManagedDirectoryBoundary,
} from '../security/managed-directory-boundary.js';
import {
  ensureRunOwnerClaim,
  runOwnerClaimPath,
  sameRunOwner,
} from '../util/run-owner.js';
import { omitUndefined } from '../util/object.js';
import {
  parseScheduleRow,
  readScheduleFile,
  scheduleMatchesScope,
  sqliteScheduleScope,
  type ScheduleRow,
} from './scheduler-store-utils.js';
import type {
  CreateScheduleStoreOptions,
  FileScheduleStoreOptions,
  ScheduleListOptions,
  ScheduleRecord,
  SqliteScheduleStoreOptions,
} from './scheduler-store-types.js';

export { normaliseTenantId, normaliseUserId } from './scheduler-store-utils.js';
export type {
  CreateScheduleStoreOptions,
  FileScheduleStoreOptions,
  ScheduleListOptions,
  ScheduleRecord,
  SqliteScheduleStoreOptions,
} from './scheduler-store-types.js';

const SCHEDULE_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

export class FileScheduleStore {
  readonly storeDir: string;
  private readonly boundary: ManagedDirectoryBoundary;

  constructor({ storeDir }: FileScheduleStoreOptions = {}) {
    if (!storeDir) {
      throw new Error('FileScheduleStore: storeDir required');
    }
    this.storeDir = path.resolve(storeDir);
    this.boundary = createManagedDirectoryBoundary(this.storeDir, { label: 'Schedule store' });
  }

  _file(id: string): string {
    if (!SCHEDULE_ID_RE.test(id)) {
      throw new Error('Scheduler: invalid schedule id');
    }
    return path.join(this.storeDir, `${id}.json`);
  }

  private readFile(file: string, expectedId: string): ScheduleRecord | null {
    const before = this.boundary.inspectPath(file, { allowMissing: true, kind: 'file' });
    if (!before) return null;
    const record = readScheduleFile(before.canonicalPath, expectedId);
    this.boundary.revalidatePath(file, before, { kind: 'file' });
    return record;
  }

  list(options: ScheduleListOptions = {}): ScheduleRecord[] {
    canonicalIdentityFilter(options);
    const rootBefore = this.boundary.inspectPath(this.storeDir, { allowMissing: true, kind: 'directory' });
    if (!rootBefore) return [];
    const out: ScheduleRecord[] = [];
    const names = fs.readdirSync(rootBefore.canonicalPath);
    this.boundary.revalidatePath(this.storeDir, rootBefore, { kind: 'directory' });
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = this.readFile(path.join(this.storeDir, name), name.slice(0, -5));
      if (!record) continue;
      if (!scheduleMatchesScope(record, options)) continue;
      out.push(record);
    }
    out.sort((a, b) => String(a.nextFireAt || '').localeCompare(String(b.nextFireAt || '')));
    return out;
  }

  get(id: string, options: ScheduleListOptions = {}): ScheduleRecord | null {
    const record = this.readFile(this._file(id), id);
    return record && scheduleMatchesScope(record, options) ? record : null;
  }

  save(record: ScheduleRecord): ScheduleRecord {
    const owner = requireIdentityScopeFrom(record, { label: 'schedule record identity' });
    const file = this._file(record.id);
    const guardMutation = this.boundary.createMutationGuard();
    if (this.boundary.inspectPath(file, { allowMissing: true, kind: 'file' })) {
      const existing = this.readFile(file, record.id);
      if (!existing) throw new Error('Schedule owner could not be verified');
      const existingOwner = requireIdentityScopeFrom(existing, { label: 'stored schedule identity' });
      if (!sameRunOwner(existingOwner, owner)) throw new Error('Schedule owner mismatch');
    }
    const claimPath = runOwnerClaimPath(this.storeDir, record.id);
    ensureRunOwnerClaim({
      claimPath,
      owner,
      label: 'Schedule',
      beforeFilesystemMutation: guardMutation,
      boundary: this.boundary,
    });
    guardMutation(claimPath);
    writePrivateFileAtomically(file, `${JSON.stringify(record, null, 2)}\n`, {
      beforeFilesystemMutation: guardMutation,
    });
    return record;
  }

  remove(id: string, options: ScheduleListOptions = {}): boolean {
    const file = this._file(id);
    const before = this.boundary.inspectPath(file, { allowMissing: true, kind: 'file' });
    if (!before) return false;
    const record = this.readFile(file, id);
    if (!record || !scheduleMatchesScope(record, options)) return false;
    this.boundary.revalidatePath(file, before, { kind: 'file' });
    fs.unlinkSync(before.canonicalPath);
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

  list(options: ScheduleListOptions = {}): ScheduleRecord[] {
    const { where, params } = sqliteScheduleScope(options);
    const rows = this.db.prepare(`
      SELECT schedule_json
      FROM schedules
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(next_fire_at, '')
    `).all(...params);
    return rows.map(parseScheduleRow).filter((record): record is ScheduleRecord => Boolean(record));
  }

  get(id: string, options: ScheduleListOptions = {}): ScheduleRecord | null {
    const { where, params } = sqliteScheduleScope(options);
    where.unshift('id = ?');
    params.unshift(id);
    const row = this.db
      .prepare(`SELECT schedule_json FROM schedules WHERE ${where.join(' AND ')}`)
      .get(...params) as ScheduleRow | null | undefined;
    return parseScheduleRow(row);
  }

  save(record: ScheduleRecord): ScheduleRecord {
    const owner = requireIdentityScopeFrom(record, { label: 'schedule record identity' });
    const result = this.db.prepare(`
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
      WHERE schedules.tenant_id = excluded.tenant_id
        AND schedules.user_id = excluded.user_id
    `).run(
      record.id,
      owner.tenantId,
      owner.userId,
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
    if (Number(result.changes) !== 1) {
      throw new Error('Scheduler: id already belongs to another owner');
    }
    return record;
  }

  remove(id: string, options: ScheduleListOptions = {}): boolean {
    const { where, params } = sqliteScheduleScope(options);
    where.unshift('id = ?');
    params.unshift(id);
    const result = this.db.prepare(`DELETE FROM schedules WHERE ${where.join(' AND ')}`).run(...params);
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
    return new SqliteScheduleStore(omitUndefined({ dbPath, db }));
  }
  return new FileScheduleStore(omitUndefined({ storeDir }));
}
