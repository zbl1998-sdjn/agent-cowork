import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDatabase } from '../storage/sqlite.js';

// Zero-dep, file-backed runs index. Repository-shaped so it can be swapped
// for a SQLite or Postgres adapter later without touching call sites.
//
// Storage layout under <indexRoot>:
//   index.jsonl  — append-only event log (one JSON event per line)
//   id.txt       — monotonic ULID-like counter persisted between restarts
//
// The current in-memory state is a Map<id, RunIndexRecord> rebuilt at boot
// by replaying index.jsonl. Reads go through the Map; writes append + update.
//
// Each event row schema:
//   { ts, tenantId, userId, traceId, id, op, ...fields }
//   op ∈ { 'upsert', 'delete' }

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PREFIX = 'run';

function pickAlphabet(byte) {
  // Map a random byte into the Crockford base32 alphabet by masking lower 5 bits.
  return ULID_ALPHABET[byte & 0x1f];
}

function timestampPart(ms) {
  // 10 chars base32 representation of milliseconds since epoch.
  let value = BigInt(ms);
  const base = BigInt(32);
  const out = new Array(10);
  for (let i = 9; i >= 0; i -= 1) {
    out[i] = ULID_ALPHABET[Number(value % base)];
    value /= base;
  }
  return out.join('');
}

export function createUlid(now = Date.now()) {
  const rand = crypto.randomBytes(16);
  const randomPart = Array.from(rand, pickAlphabet).join('');
  return `${ID_PREFIX}_${timestampPart(now)}${randomPart}`;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(file, event) {
  ensureDirSync(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normaliseTenantId(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'tenant_local';
  }
  if (text.length > 96) {
    return text.slice(0, 96);
  }
  return text;
}

function normaliseUserId(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'user_local';
  }
  if (text.length > 96) {
    return text.slice(0, 96);
  }
  return text;
}

function normaliseRecord(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('runs-index: record must be an object');
  }
  const id = String(record.id || '').trim();
  if (!id) {
    throw new Error('runs-index: record.id is required');
  }
  return {
    id,
    tenantId: normaliseTenantId(record.tenantId),
    userId: normaliseUserId(record.userId),
    traceId: String(record.traceId || ''),
    type: String(record.type || ''),
    status: String(record.status || ''),
    mode: record.mode ? String(record.mode) : null,
    provider: record.provider ? String(record.provider) : null,
    recipeId: record.recipeId ? String(record.recipeId) : null,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
    promptPreview: typeof record.promptPreview === 'string' ? record.promptPreview.slice(0, 240) : null,
    error: record.error ? String(record.error).slice(0, 1024) : null,
    runPath: record.runPath ? String(record.runPath) : null,
    version: Number(record.version) || 1,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
}

export class RunsIndex {
  constructor({ indexRoot, now = () => new Date() } = {}) {
    if (!indexRoot || typeof indexRoot !== 'string') {
      throw new Error('RunsIndex: indexRoot is required');
    }
    this.indexRoot = indexRoot;
    this.eventFile = path.join(indexRoot, 'index.jsonl');
    this.now = now;
    this.records = new Map();
    this._replay();
  }

  _replay() {
    const events = readJsonl(this.eventFile);
    for (const event of events) {
      if (!event || !event.id) {
        continue;
      }
      if (event.op === 'delete') {
        this.records.delete(event.id);
        continue;
      }
      const previous = this.records.get(event.id) || {};
      this.records.set(event.id, { ...previous, ...event.record });
    }
  }

  upsert(record, context = {}) {
    const normalised = normaliseRecord(record);
    const existing = this.records.get(normalised.id);
    if (existing) {
      normalised.version = (Number(existing.version) || 0) + 1;
    }
    normalised.updatedAt = this.now().toISOString();
    this.records.set(normalised.id, normalised);
    appendJsonl(this.eventFile, {
      ts: normalised.updatedAt,
      op: 'upsert',
      id: normalised.id,
      tenantId: normalised.tenantId,
      userId: normalised.userId,
      traceId: context.traceId || normalised.traceId,
      record: normalised,
    });
    return normalised;
  }

  remove(id, context = {}) {
    const existing = this.records.get(id);
    if (!existing) {
      return false;
    }
    this.records.delete(id);
    appendJsonl(this.eventFile, {
      ts: this.now().toISOString(),
      op: 'delete',
      id,
      tenantId: existing.tenantId,
      userId: existing.userId,
      traceId: context.traceId || existing.traceId,
    });
    return true;
  }

  get(id, { tenantId } = {}) {
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    if (tenantId && record.tenantId !== normaliseTenantId(tenantId)) {
      return null;
    }
    return record;
  }

  list({ tenantId, userId, limit = 50, status, type, recipeId } = {}) {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    const wantUser = userId ? normaliseUserId(userId) : null;
    const out = [];
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      if (wantUser && record.userId !== wantUser) continue;
      if (status && record.status !== status) continue;
      if (type && record.type !== type) continue;
      if (recipeId && record.recipeId !== recipeId) continue;
      out.push(record);
    }
    out.sort((a, b) => String(b.startedAt || b.updatedAt).localeCompare(String(a.startedAt || a.updatedAt)));
    const cap = Math.max(1, Math.min(Number(limit) || 50, 500));
    return out.slice(0, cap);
  }

  size() {
    return this.records.size;
  }

  stats({ tenantId } = {}) {
    const wantTenant = tenantId ? normaliseTenantId(tenantId) : null;
    let total = 0;
    const byStatus = Object.create(null);
    const byType = Object.create(null);
    for (const record of this.records.values()) {
      if (wantTenant && record.tenantId !== wantTenant) continue;
      total += 1;
      byStatus[record.status] = (byStatus[record.status] || 0) + 1;
      byType[record.type] = (byType[record.type] || 0) + 1;
    }
    return { total, byStatus, byType };
  }
}

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
    const row = this.db
      .prepare('SELECT record_json FROM runs_index WHERE id = ?')
      .get(id);
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
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM runs_index
      ${whereSql}
    `).get(...params);
    const byStatus = Object.create(null);
    const byType = Object.create(null);
    const statusRows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM runs_index
      ${whereSql}
      GROUP BY status
    `).all(...params);
    for (const row of statusRows) {
      byStatus[row.status] = Number(row.count) || 0;
    }
    const typeRows = this.db.prepare(`
      SELECT type, COUNT(*) AS count
      FROM runs_index
      ${whereSql}
      GROUP BY type
    `).all(...params);
    for (const row of typeRows) {
      byType[row.type] = Number(row.count) || 0;
    }
    return { total: Number(totalRow?.count || 0), byStatus, byType };
  }
}

export function createRunsIndex({ backend = 'file', indexRoot, dbPath, db, now } = {}) {
  if (backend === 'sqlite') {
    return new SqliteRunsIndex({ dbPath, db, now });
  }
  return new RunsIndex({ indexRoot, now });
}

export function summariseRunForIndex(runRecord, context = {}) {
  if (!runRecord || typeof runRecord !== 'object') {
    throw new Error('summariseRunForIndex: runRecord required');
  }
  const promptText = typeof runRecord.input?.prompt === 'string' ? runRecord.input.prompt : '';
  return {
    id: runRecord.id,
    tenantId: context.tenantId || runRecord.context?.tenantId,
    userId: context.userId || runRecord.context?.userId,
    traceId: context.traceId || runRecord.context?.traceId,
    type: runRecord.type,
    status: runRecord.status,
    mode: runRecord.mode,
    provider: runRecord.provider,
    recipeId: runRecord.recipeId,
    startedAt: runRecord.startedAt,
    finishedAt: runRecord.finishedAt,
    durationMs: runRecord.durationMs,
    promptPreview: promptText.slice(0, 240),
    error: runRecord.error?.message,
    runPath: runRecord.runPath || null,
  };
}
