// PostgreSQL adapter for per-user conversation history. Tests inject a mock pool.
// @ts-check

import crypto from 'node:crypto';
import path from 'node:path';

/**
 * @typedef {{ rows?: unknown[], rowCount?: number | null }} PgResult
 * @typedef {{ query(text: string, params?: unknown[]): Promise<PgResult>, end?: () => Promise<unknown> }} PgPool
 * @typedef {new (options?: Record<string, unknown>) => PgPool} PgPoolConstructor
 * @typedef {{ default?: { Pool?: PgPoolConstructor }, Pool?: PgPoolConstructor }} PgModule
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ConversationContext
 * @typedef {{ id: string, title: string, parentBranchId?: string, baseMessageId?: string, createdAt?: string, messages: unknown[] }} ConversationBranch
 * @typedef {{ id?: unknown, title?: unknown, pinned?: unknown, messages?: unknown, activeBranchId?: unknown, branches?: unknown }} ConversationInput
 * @typedef {{ id: string, title: string, pinned: boolean, messages: unknown[], activeBranchId?: string, branches: ConversationBranch[], createdAt?: unknown, updatedAt?: unknown }} ConversationRecord
 * @typedef {{ id: string, title: string, pinned: boolean, messageCount: number, branchCount: number, activeBranchId?: string, createdAt?: unknown, updatedAt?: unknown }} ConversationSummary
 * @typedef {{ q?: unknown, limit?: unknown, offset?: unknown }} ConversationQueryOptions
 * @typedef {{ items: ConversationSummary[], total: number }} ConversationQueryResult
 * @typedef {{ limit?: number }} ConversationListFullOptions
 * @typedef {{ pool?: PgPool | null, connectionString?: string | null, now?: () => Date }} PostgresConversationStoreOptions
 * @typedef {{ id?: unknown, title?: unknown, pinned?: unknown, message_count?: unknown, branch_count?: unknown, active_branch_id?: unknown, created_at?: unknown, updated_at?: unknown, messages?: unknown, branches?: unknown, total?: unknown }} ConversationRow
 */

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_TITLE = 200;

/** @param {unknown} v @param {string} fb @returns {string} */
function clampId(v, fb) { const t = String(v || '').trim(); return t ? t.slice(0, 96) : fb; }
/** @param {unknown} v @returns {string} */
const normTenant = (v) => clampId(v, 'tenant_local');
/** @param {unknown} v @returns {string} */
const normUser = (v) => clampId(v, 'user_local');

/** @param {unknown} trustedRoot @returns {string} */
function workspaceKey(trustedRoot) {
  const root = path.resolve(String(trustedRoot || ''));
  return crypto.createHash('sha256').update(root).digest('hex');
}

/** @param {unknown} id @returns {string} */
function cleanId(id) {
  const t = String(id || '').trim();
  if (!ID_RE.test(t)) throw new Error('invalid conversation id');
  return t;
}
/** @param {unknown} messages @returns {unknown[]} */
function sanitizeMessages(messages) {
  return Array.isArray(messages) ? messages.slice(-200) : [];
}
/** @param {unknown} value @returns {string} */
function safeOptionalId(value) {
  const t = String(value || '').trim();
  return ID_RE.test(t) ? t : '';
}
/** @param {unknown} branches @returns {ConversationBranch[]} */
function sanitizeBranches(branches) {
  if (!Array.isArray(branches)) return [];
  return branches.slice(-12).map((branch, index) => {
    const id = safeOptionalId(branch && branch.id) || (index === 0 ? 'main' : `branch-${index}`);
    return {
      id,
      title: String((branch && branch.title) || (index === 0 ? '主线' : `分支 ${index}`)).slice(0, MAX_TITLE),
      ...(safeOptionalId(branch && branch.parentBranchId) ? { parentBranchId: String(branch.parentBranchId) } : {}),
      ...(branch && branch.baseMessageId ? { baseMessageId: String(branch.baseMessageId).slice(0, 96) } : {}),
      ...(branch && branch.createdAt ? { createdAt: String(branch.createdAt).slice(0, 64) } : {}),
      messages: sanitizeMessages(branch && branch.messages),
    };
  });
}

/** @param {unknown} value @returns {unknown[]} */
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** @param {ConversationRow} row @returns {ConversationBranch[]} */
function parseBranches(row) { return /** @type {ConversationBranch[]} */ (parseJsonArray(row.branches)); }
/** @param {ConversationRow} row @returns {ConversationSummary} */
function summariseRow(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || '新对话'),
    pinned: Boolean(row.pinned),
    messageCount: Number(row.message_count) || 0,
    branchCount: Number(row.branch_count) || 0,
    activeBranchId: row.active_branch_id ? String(row.active_branch_id) : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}
/** @param {ConversationRow} row @returns {unknown[]} */
function parseMessages(row) { return parseJsonArray(row.messages); }
/** @param {ConversationRow} row @returns {ConversationRecord} */
function fullRow(row) {
  return {
    id: String(row.id || ''),
    title: String(row.title || '新对话'),
    pinned: Boolean(row.pinned),
    messages: parseMessages(row),
    activeBranchId: row.active_branch_id ? String(row.active_branch_id) : undefined,
    branches: parseBranches(row),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

export class PostgresConversationStore {
  /** @param {PostgresConversationStoreOptions} [options] */
  constructor({ pool = null, connectionString = null, now = () => new Date() } = {}) {
    /** @type {PgPool | null} */
    this._pool = pool;
    /** @type {string | null} */
    this._connectionString = connectionString;
    /** @type {() => Date} */
    this._now = now;
  }

  /** @returns {Promise<PgPool>} */
  async _getPool() {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresConversationStore: pool or connectionString is required');
    let pg;
    try { pg = /** @type {PgModule} */ (await import('pg')); } catch { throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`."); }
    const Pool = pg.default?.Pool || pg.Pool;
    if (!Pool) throw new Error("PostgreSQL backend requires the 'pg' Pool export.");
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** @param {string} text @param {unknown[]} [params] @returns {Promise<PgResult>} */
  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  /** @param {unknown} trustedRoot @param {ConversationContext} [context] @returns {Promise<ConversationSummary[]>} */
  async list(trustedRoot, context = {}) {
    const r = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count,
              COALESCE(jsonb_array_length(branches), 0) AS branch_count, active_branch_id,
              created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 ORDER BY updated_at DESC`,
      [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot)],
    );
    return (r.rows || []).map((row) => summariseRow(/** @type {ConversationRow} */ (row)));
  }

  /** @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationQueryOptions} [options] @returns {Promise<ConversationQueryResult>} */
  async query(trustedRoot, context = {}, { q = '', limit = 30, offset = 0 } = {}) {
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const wsKey = workspaceKey(trustedRoot);
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const ql = String(q || '').trim();
    const where = ql
      ? `tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND title ILIKE $4`
      : `tenant_id=$1 AND user_id=$2 AND workspace_key=$3`;
    /** @type {unknown[]} */
    const whereParams = ql ? [tenantId, userId, wsKey, `%${ql}%`] : [tenantId, userId, wsKey];
    const countRes = await this._query(`SELECT COUNT(*)::int AS total FROM conversations WHERE ${where}`, whereParams);
    const totalRow = /** @type {ConversationRow | undefined} */ (countRes.rows && countRes.rows[0]);
    const total = (totalRow && Number(totalRow.total)) || 0;
    const rowsRes = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count,
              COALESCE(jsonb_array_length(branches), 0) AS branch_count, active_branch_id,
              created_at, updated_at
       FROM conversations WHERE ${where} ORDER BY updated_at DESC LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
      [...whereParams, lim, off],
    );
    return { items: (rowsRes.rows || []).map((row) => summariseRow(/** @type {ConversationRow} */ (row))), total };
  }

  /** @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationListFullOptions} [options] @returns {Promise<ConversationRecord[]>} */
  async listFull(trustedRoot, context = {}, { limit } = {}) {
    const hasLimit = typeof limit === 'number';
    const r = await this._query(
      `SELECT id, title, pinned, messages, branches, active_branch_id, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 ORDER BY updated_at DESC${hasLimit ? ' LIMIT $4' : ''}`,
      hasLimit
        ? [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot), Math.max(0, limit)]
        : [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot)],
    );
    return (r.rows || []).map((row) => fullRow(/** @type {ConversationRow} */ (row)));
  }

  /** @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {Promise<ConversationRecord | null>} */
  async get(trustedRoot, id, context = {}) {
    const r = await this._query(
      `SELECT id, title, pinned, messages, branches, active_branch_id, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot), cleanId(id)],
    );
    const row = /** @type {ConversationRow | undefined} */ (r.rows && r.rows[0]);
    return row ? fullRow(row) : null;
  }

  /** @param {unknown} trustedRoot @param {ConversationInput} conv @param {ConversationContext} [context] @returns {Promise<ConversationSummary>} */
  async save(trustedRoot, conv, context = {}) {
    const id = cleanId(conv && conv.id);
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const wsKey = workspaceKey(trustedRoot);
    const now = this._now().toISOString();
    const title = String((conv && conv.title) || '新对话').slice(0, MAX_TITLE);
    const pinned = Boolean(conv && conv.pinned);
    const messages = sanitizeMessages(conv && conv.messages);
    const branches = sanitizeBranches(conv && conv.branches);
    const requestedActive = safeOptionalId(conv && conv.activeBranchId);
    const activeBranchId = branches.some((branch) => branch.id === requestedActive)
      ? requestedActive
      : branches[0]?.id || null;
    const r = await this._query(
      `INSERT INTO conversations (tenant_id, user_id, workspace_key, id, title, pinned, messages, branches, active_branch_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
       ON CONFLICT (tenant_id, user_id, workspace_key, id) DO UPDATE SET
         title=EXCLUDED.title, pinned=EXCLUDED.pinned, messages=EXCLUDED.messages,
         branches=EXCLUDED.branches, active_branch_id=EXCLUDED.active_branch_id, updated_at=EXCLUDED.updated_at
       RETURNING id, title, pinned, jsonb_array_length(messages) AS message_count,
                 COALESCE(jsonb_array_length(branches), 0) AS branch_count, active_branch_id,
                 created_at, updated_at`,
      [tenantId, userId, wsKey, id, title, pinned, JSON.stringify(messages), JSON.stringify(branches), activeBranchId, now, now],
    );
    const row = /** @type {ConversationRow} */ ((r.rows && r.rows[0]) || {
      id, title, pinned, message_count: messages.length, branch_count: branches.length,
      active_branch_id: activeBranchId, created_at: now, updated_at: now,
    });
    return summariseRow(row);
  }

  /** @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {Promise<boolean>} */
  async remove(trustedRoot, id, context = {}) {
    const r = await this._query(
      `DELETE FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot), cleanId(id)],
    );
    return (r.rowCount || 0) > 0;
  }

  /** @returns {Promise<void>} */
  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** @param {PostgresConversationStoreOptions} [options] @returns {PostgresConversationStore} */
export function createPostgresConversationStore(options = {}) {
  return new PostgresConversationStore(options);
}
