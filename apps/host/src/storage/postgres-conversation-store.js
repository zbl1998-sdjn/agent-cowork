// 按用户对话历史的 PostgreSQL 适配(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:与 FileConversationStore 同接口的 PG 后端——按 tenant/user/workspace_key 隔离,
//       提供 list/query/listFull/get/save(upsert)/remove;沿用同样的 id/分支/消息清洗。
// 依赖:仅标准库(crypto/path);pg 运行时按需 import。后端:PostgreSQL(conversations 表)。
// 导出:PostgresConversationStore(类) · createPostgresConversationStore(工厂)。
//
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

/** 用受信根目录的 sha256 作为工作区隔离键,使同库不同工作区互不串数据。 @param {unknown} trustedRoot @returns {string} */
function workspaceKey(trustedRoot) {
  const root = path.resolve(String(trustedRoot || ''));
  return crypto.createHash('sha256').update(root).digest('hex');
}

/** 校验对话 id 合法性,非法抛错。 @param {unknown} id @returns {string} */
function cleanId(id) {
  const t = String(id || '').trim();
  if (!ID_RE.test(t)) throw new Error('invalid conversation id');
  return t;
}
/** 仅保留最近 200 条消息。 @param {unknown} messages @returns {unknown[]} */
function sanitizeMessages(messages) {
  return Array.isArray(messages) ? messages.slice(-200) : [];
}
/** 校验可选 id,非法返回空串。 @param {unknown} value @returns {string} */
function safeOptionalId(value) {
  const t = String(value || '').trim();
  return ID_RE.test(t) ? t : '';
}
/** 清洗分支列表(限 12 条、补默认 id/标题、逐分支裁剪消息)。 @param {unknown} branches @returns {ConversationBranch[]} */
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

/** 把列值解析为数组:已是数组直接用,字符串则尝试 JSON.parse,失败返回空数组。 @param {unknown} value @returns {unknown[]} */
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** 从行解析分支数组。 @param {ConversationRow} row @returns {ConversationBranch[]} */
function parseBranches(row) { return /** @type {ConversationBranch[]} */ (parseJsonArray(row.branches)); }
/** 把 DB 行映射为列表摘要(Date 列转 ISO 串)。 @param {ConversationRow} row @returns {ConversationSummary} */
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
/** 从行解析消息数组。 @param {ConversationRow} row @returns {unknown[]} */
function parseMessages(row) { return parseJsonArray(row.messages); }
/** 把 DB 行映射为完整对话记录(含消息/分支正文,Date 列转 ISO 串)。 @param {ConversationRow} row @returns {ConversationRecord} */
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

/** 对话历史的 PG 后端,接口与 FileConversationStore 对齐,按 tenant/user/workspace 隔离。 */
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

  /** 取/建连接池(pg 按需 import,缺包给出安装提示)。 @returns {Promise<PgPool>} */
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

  /** 取池后执行参数化查询。 @param {string} text @param {unknown[]} [params] @returns {Promise<PgResult>} */
  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  /** 列出该 tenant/user/workspace 的对话摘要(更新时间倒序)。 @param {unknown} trustedRoot @param {ConversationContext} [context] @returns {Promise<ConversationSummary[]>} */
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

  /** 标题 ILIKE 搜索 + 分页,返回 { items, total };limit 夹在 1~200。 @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationQueryOptions} [options] @returns {Promise<ConversationQueryResult>} */
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

  /** 返回完整对话记录(含消息/分支正文),可选 limit。 @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationListFullOptions} [options] @returns {Promise<ConversationRecord[]>} */
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

  /** 取单个对话完整记录,不存在返回 null。 @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {Promise<ConversationRecord | null>} */
  async get(trustedRoot, id, context = {}) {
    const r = await this._query(
      `SELECT id, title, pinned, messages, branches, active_branch_id, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot), cleanId(id)],
    );
    const row = /** @type {ConversationRow | undefined} */ (r.rows && r.rows[0]);
    return row ? fullRow(row) : null;
  }

  /** upsert 对话(按 tenant/user/workspace/id 冲突更新),清洗后写入并返回摘要。 @param {unknown} trustedRoot @param {ConversationInput} conv @param {ConversationContext} [context] @returns {Promise<ConversationSummary>} */
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

  /** 删除单个对话,返回是否真的删除。 @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {Promise<boolean>} */
  async remove(trustedRoot, id, context = {}) {
    const r = await this._query(
      `DELETE FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [normTenant(context.tenantId), normUser(context.userId), workspaceKey(trustedRoot), cleanId(id)],
    );
    return (r.rowCount || 0) > 0;
  }

  /** 关闭连接池。 @returns {Promise<void>} */
  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** 工厂:构造 PG 后端对话存储。 @param {PostgresConversationStoreOptions} [options] @returns {PostgresConversationStore} */
export function createPostgresConversationStore(options = {}) {
  return new PostgresConversationStore(options);
}
