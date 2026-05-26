import { createSqliteDatabase } from '../storage/sqlite.js';
import { normaliseRecord, normaliseTenantId, normaliseUserId } from './runs-index-utils.js';

export class SqliteRunsIndex {
  constructor({ dbPath, db = null, now = () => new Date() } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteRunsIndex: dbPath is required');
    }
    this.db = db || createSqliteDatabase(dbPath);
    this.now = now;
  }

  upsert(record, context = {}) {
    const normalised = normaliseRecord(record);
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

  remove(id) {
    const result = this.db.prepare('DELETE FROM runs_index WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  get(id, { tenantId } = {}) {
    const row = this.db.prepare('SELECT record_json FROM runs_index WHERE id = ?').get(id);
    if (!row) {
      return null;
    }
    const record = JSON.parse(row.record_json);
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
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
    `).all(...params, cap);
    return rows.map((row) => JSON.parse(row.record_json));
  }

  size() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM runs_index').get();
    return Number(row?.count || 0);
  }

  stats({ tenantId } = {}) {
    const where = [];
    const params = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(normaliseTenantId(tenantId));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM runs_index ${whereSql}`).get(...params);
    const byStatus = Object.create(null);
    const byType = Object.create(null);
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY status
    `).all(...params);
    for (const row of statusRows) {
      byStatus[row.status] = Number(row.count) || 0;
    }
    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY type
    `).all(...params);
    for (const row of typeRows) {
      byType[row.type] = Number(row.count) || 0;
    }
    return { total: Number(totalRow?.count || 0), byStatus, byType };
  }
}
