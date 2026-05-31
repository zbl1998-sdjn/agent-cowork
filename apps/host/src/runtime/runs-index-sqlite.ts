// 运行索引·SQLite 后端(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:运行索引的 SQLite 持久化后端,与文件后端同接口(端口与适配器),适合需要高效查询/大量历史的场景。
// 依赖:storage/sqlite + 同层 runs-index-utils。导出:SqliteRunsIndex。
import { createSqliteDatabase, type SqliteDatabase } from '../storage/sqlite.js';
import {
  normaliseRecord,
  normaliseTenantId,
  normaliseUserId,
  type NormalisedRunRecord,
} from './runs-index-utils.js';

export type RunIndexRecord = NormalisedRunRecord & Record<string, unknown>;
export type SqliteRunsIndexOptions = { dbPath?: string; db?: SqliteDatabase | null; now?: () => Date };
export type RunsIndexContext = { traceId?: unknown };
export type RunsIndexListOptions = {
  tenantId?: unknown;
  userId?: unknown;
  limit?: unknown;
  status?: unknown;
  type?: unknown;
  recipeId?: unknown;
};
type RunsIndexRow = { record_json?: string; count?: unknown; status?: unknown; type?: unknown };

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
    const existing = this.get(normalised.id);
    const now = this.now().toISOString();
    if (existing) {
      normalised.version = (Number(existing.version) || 0) + 1;
    }
    normalised.updatedAt = now;
    const createdAt = existing?.startedAt || existing?.updatedAt || normalised.startedAt || now;
    this.db.prepare(`
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
        version = excluded.version,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `).run(
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
    );
    return normalised;
  }

  remove(id: unknown): boolean {
    const result = this.db.prepare('DELETE FROM runs_index WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  get(id: unknown, { tenantId }: { tenantId?: unknown } = {}): RunIndexRecord | null {
    const row = this.db.prepare('SELECT record_json FROM runs_index WHERE id = ?').get(id) as RunsIndexRow | null | undefined;
    if (!row) {
      return null;
    }
    const record = JSON.parse(String(row.record_json || '{}')) as RunIndexRecord;
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  list({
    tenantId,
    userId,
    limit = 50,
    status,
    type,
    recipeId,
  }: RunsIndexListOptions = {}): RunIndexRecord[] {
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
    return rows.map((row) => JSON.parse(String(row.record_json || '{}')) as RunIndexRecord);
  }

  size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM runs_index').get() as RunsIndexRow | null | undefined;
    return Number(row?.count || 0);
  }

  stats({ tenantId }: { tenantId?: unknown } = {}): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(normaliseTenantId(tenantId));
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
