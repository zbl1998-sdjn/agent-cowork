// 运行索引·SQLite 后端(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:运行索引的 SQLite 持久化后端,与文件后端同接口(端口与适配器),适合需要高效查询/大量历史的场景。
// 依赖:同层 sqlite + runs-index-utils。导出:SqliteRunsIndex。
import { createSqliteDatabase, type SqliteDatabase } from './sqlite.js';
import {
  canonicalIdentityFilter,
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';
import {
  normaliseRecord,
  type NormalisedRunRecord,
} from './runs-index-utils.js';

export type RunIndexRecord = NormalisedRunRecord & Record<string, unknown>;
export type SqliteRunsIndexOptions = { dbPath?: string; db?: SqliteDatabase | null; now?: () => Date };
export type RunsIndexContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown };
export type RunsIndexListOptions = {
  tenantId?: unknown;
  userId?: unknown;
  limit?: unknown;
  status?: unknown;
  type?: unknown;
  recipeId?: unknown;
};
type RunsIndexRow = { record_json?: string; count?: unknown; status?: unknown; type?: unknown };

function requireOwnerContext(context: RunsIndexContext): { tenantId: string; userId: string } {
  return requireIdentityScopeFrom(context, { label: 'runs-index owner context' });
}

function parseStoredRecord(row: RunsIndexRow | null | undefined): RunIndexRecord | null {
  if (!row || typeof row.record_json !== 'string') return null;
  try {
    const parsed = JSON.parse(row.record_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as RunIndexRecord;
    if (!canonicalRequiredIdentityScope(record.tenantId, record.userId)) return null;
    return record;
  } catch {
    return null;
  }
}

export class SqliteRunsIndex {
  readonly db: SqliteDatabase;
  readonly now: () => Date;

  constructor({ dbPath, db = null, now = () => new Date() }: SqliteRunsIndexOptions = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteRunsIndex: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath as string);
    this.now = now;
  }

  upsert(record: unknown, context: RunsIndexContext = {}): RunIndexRecord {
    const normalised = normaliseRecord(record) as RunIndexRecord;
    const now = this.now().toISOString();
    normalised.updatedAt = now;
    const createdAt = normalised.startedAt || now;
    const row = this.db.prepare(`
      INSERT INTO runs_index (
        id, tenant_id, user_id, trace_id, type, status, mode, provider, recipe_id,
        started_at, finished_at, duration_ms, prompt_preview, error, run_path,
        version, created_at, updated_at, record_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        user_id = excluded.user_id,
        trace_id = excluded.trace_id,
        type = excluded.type,
        status = excluded.status,
        mode = excluded.mode,
        provider = excluded.provider,
        recipe_id = excluded.recipe_id,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        duration_ms = excluded.duration_ms,
        prompt_preview = excluded.prompt_preview,
        error = excluded.error,
        run_path = excluded.run_path,
        version = runs_index.version + 1,
        updated_at = excluded.updated_at,
        record_json = json_set(excluded.record_json, '$.version', runs_index.version + 1)
      WHERE runs_index.tenant_id = excluded.tenant_id
        AND runs_index.user_id = excluded.user_id
      RETURNING record_json
    `).get(
      normalised.id,
      normalised.tenantId,
      normalised.userId,
      context.traceId || normalised.traceId,
      normalised.type,
      normalised.status,
      normalised.mode,
      normalised.provider,
      normalised.recipeId,
      normalised.startedAt,
      normalised.finishedAt,
      normalised.durationMs,
      normalised.promptPreview,
      normalised.error,
      normalised.runPath,
      normalised.version,
      createdAt,
      normalised.updatedAt,
      JSON.stringify(normalised),
    ) as RunsIndexRow | null | undefined;
    if (!row) {
      throw new Error('runs-index: id already belongs to another owner');
    }
    const stored = parseStoredRecord(row);
    if (!stored) throw new Error('runs-index: upsert did not return a valid record');
    return stored;
  }

  remove(id: unknown, context: RunsIndexContext = {}): boolean {
    const owner = requireOwnerContext(context);
    const result = this.db.prepare(
      'DELETE FROM runs_index WHERE id = ? AND tenant_id = ? AND user_id = ?',
    ).run(id, owner.tenantId, owner.userId);
    return Number(result.changes) > 0;
  }

  get(id: unknown, options: { tenantId?: unknown; userId?: unknown } = {}): RunIndexRecord | null {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where = ['id = ?'];
    const params: unknown[] = [id];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    const row = this.db.prepare(`SELECT record_json FROM runs_index WHERE ${where.join(' AND ')}`).get(...params) as RunsIndexRow | null | undefined;
    if (!row) {
      return null;
    }
    return parseStoredRecord(row);
  }

  list(options: RunsIndexListOptions = {}): RunIndexRecord[] {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const {
      limit = 50,
      status,
      type,
      recipeId,
    } = options;
    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    if (status) {
      where.push('status = ?');
      params.push(String(status));
    }
    if (type) {
      where.push('type = ?');
      params.push(String(type));
    }
    if (recipeId) {
      where.push('recipe_id = ?');
      params.push(String(recipeId));
    }
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    const rows = this.db.prepare(`
      SELECT record_json
      FROM runs_index
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(started_at, updated_at, created_at) DESC
      LIMIT ?
    `).all(...params, cap) as RunsIndexRow[];
    return rows.map(parseStoredRecord).filter((record): record is RunIndexRecord => Boolean(record));
  }

  size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM runs_index').get() as RunsIndexRow | null | undefined;
    return Number(row?.count || 0);
  }

  stats(options: { tenantId?: unknown; userId?: unknown } = {}): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const { tenantId, userId } = canonicalIdentityFilter(options);
    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(tenantId);
    }
    if (userId) {
      where.push('user_id = ?');
      params.push(userId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM runs_index ${whereSql}`).get(...params) as RunsIndexRow | null | undefined;
    const byStatus: Record<string, number> = Object.create(null);
    const byType: Record<string, number> = Object.create(null);
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY status
    `).all(...params) as RunsIndexRow[];
    for (const row of statusRows) {
      byStatus[String(row.status || '')] = Number(row.count) || 0;
    }
    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY type
    `).all(...params) as RunsIndexRow[];
    for (const row of typeRows) {
      byType[String(row.type || '')] = Number(row.count) || 0;
    }
    return { total: Number(totalRow?.count || 0), byStatus, byType };
  }
}
