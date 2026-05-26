// @ts-check
import { createSqliteDatabase } from '../storage/sqlite.js';
import { normaliseRecord, normaliseTenantId, normaliseUserId } from './runs-index-utils.js';

/**
 * @typedef {{ get(...params: unknown[]): unknown, run(...params: unknown[]): { changes?: number }, all(...params: unknown[]): unknown[] }} SqliteStatement
 * @typedef {{ prepare(sql: string): SqliteStatement }} SqliteDatabase
 * @typedef {{ id: string, tenantId: string, userId: string, traceId: string, type: string, status: string, startedAt?: unknown, updatedAt?: unknown, version?: number, [key: string]: unknown }} RunIndexRecord
 * @typedef {{ dbPath?: string, db?: SqliteDatabase | null, now?: () => Date }} SqliteRunsIndexOptions
 * @typedef {{ traceId?: unknown }} RunsIndexContext
 * @typedef {{ tenantId?: unknown, userId?: unknown, limit?: unknown, status?: unknown, type?: unknown, recipeId?: unknown }} RunsIndexListOptions
 * @typedef {{ record_json?: string, count?: unknown, status?: unknown, type?: unknown }} RunsIndexRow
 */

export class SqliteRunsIndex {
  /** @param {SqliteRunsIndexOptions} [options] */
  constructor({ dbPath, db = null, now = () => new Date() } = {}) {
    if (!db && (!dbPath || typeof dbPath !== 'string')) {
      throw new Error('SqliteRunsIndex: dbPath is required');
    }
    this.db = db || createSqliteDatabase(/** @type {string} */ (dbPath));
    this.now = now;
  }

  /**
   * @param {unknown} record
   * @param {RunsIndexContext} [context]
   * @returns {RunIndexRecord}
   */
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

  /** @param {unknown} id @returns {boolean} */
  remove(id) {
    const result = this.db.prepare('DELETE FROM runs_index WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /**
   * @param {unknown} id
   * @param {{ tenantId?: unknown }} [options]
   * @returns {RunIndexRecord | null}
   */
  get(id, { tenantId } = {}) {
    const row = /** @type {RunsIndexRow | null | undefined} */ (this.db.prepare('SELECT record_json FROM runs_index WHERE id = ?').get(id));
    if (!row) {
      return null;
    }
    const record = /** @type {RunIndexRecord} */ (JSON.parse(String(row.record_json || '{}')));
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  /** @param {RunsIndexListOptions} [options] @returns {RunIndexRecord[]} */
  list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
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
    return rows.map((row) => JSON.parse(String(/** @type {RunsIndexRow} */ (row).record_json || '{}')));
  }

  /** @returns {number} */
  size() {
    const row = /** @type {RunsIndexRow | null | undefined} */ (this.db.prepare('SELECT COUNT(*) AS count FROM runs_index').get());
    return Number(row?.count || 0);
  }

  /**
   * @param {{ tenantId?: unknown }} [options]
   * @returns {{ total: number, byStatus: Record<string, number>, byType: Record<string, number> }}
   */
  stats({ tenantId } = {}) {
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
    const params = [];
    if (tenantId) {
      where.push('tenant_id = ?');
      params.push(normaliseTenantId(tenantId));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = /** @type {RunsIndexRow | null | undefined} */ (this.db.prepare(`SELECT COUNT(*) AS count FROM runs_index ${whereSql}`).get(...params));
    /** @type {Record<string, number>} */
    const byStatus = Object.create(null);
    /** @type {Record<string, number>} */
    const byType = Object.create(null);
    const statusRows = /** @type {RunsIndexRow[]} */ (this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY status
    `).all(...params));
    for (const row of statusRows) {
      byStatus[String(row.status || '')] = Number(row.count) || 0;
    }
    const typeRows = /** @type {RunsIndexRow[]} */ (this.db.prepare(`
      SELECT type, COUNT(*) AS count FROM runs_index ${whereSql} GROUP BY type
    `).all(...params));
    for (const row of typeRows) {
      byType[String(row.type || '')] = Number(row.count) || 0;
    }
    return { total: Number(totalRow?.count || 0), byStatus, byType };
  }
}
