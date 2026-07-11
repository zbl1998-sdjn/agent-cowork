// 按用户对话历史的 PostgreSQL 适配(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:与 FileConversationStore 同接口的 PG 后端——按 tenant/user/workspace_key 隔离,
//       提供 list/query/listFull/get/save(upsert)/remove;沿用同样的 id/分支/消息清洗。
// 依赖:仅标准库(crypto/path);pg 运行时按需 import。后端:PostgreSQL(conversations 表)。
// 导出:PostgresConversationStore(类) · createPostgresConversationStore(工厂)。
import crypto from 'node:crypto';
import path from 'node:path';
import { omitUndefined } from '../util/object.js';
import {
  cleanConversationId,
  MAX_CONVERSATION_TITLE,
  safeOptionalConversationId,
  sanitizeConversationBranches,
  sanitizeConversationMessages,
} from './conversation-sanitizers.js';
import { conversationOwnerValues } from './conversation-owner.js';
import type {
  ConversationBranch,
  ConversationContext,
  ConversationInput,
  ConversationListFullOptions,
  ConversationQueryOptions,
  ConversationQueryResult,
  ConversationRecord,
  ConversationSummary,
} from './conversation-store.js';

type PgResult = { rows?: unknown[]; rowCount?: number | null };
export type PgPool = { query(text: string, params?: unknown[]): Promise<PgResult>; end?: () => Promise<unknown> };
type PgPoolConstructor = new (options?: Record<string, unknown>) => PgPool;
type PgModule = { default?: { Pool?: PgPoolConstructor }; Pool?: PgPoolConstructor };
export type PostgresConversationStoreOptions = { pool?: PgPool | null; connectionString?: string | null; now?: () => Date };
type ConversationRow = {
  id?: unknown;
  title?: unknown;
  pinned?: unknown;
  message_count?: unknown;
  branch_count?: unknown;
  active_branch_id?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  messages?: unknown;
  branches?: unknown;
  total?: unknown;
};

function ownerParams(context: ConversationContext): [string, string] {
  const owner = conversationOwnerValues(context);
  return [owner.tenantId, owner.userId];
}

/** 用版本化 sha256 工作区键隔离新数据;旧版无前缀 key 一律 fail-closed。 */
function workspaceKey(trustedRoot: unknown): string {
  const root = path.resolve(String(trustedRoot || ''));
  return `v1-${crypto.createHash('sha256').update(root).digest('hex')}`;
}

/** 把列值解析为数组:已是数组直接用,字符串则尝试 JSON.parse,失败返回空数组。 */
function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** 从行解析分支数组。 */
function parseBranches(row: ConversationRow): ConversationBranch[] { return parseJsonArray(row.branches) as ConversationBranch[]; }
/** 把 DB 行映射为列表摘要(Date 列转 ISO 串)。 */
function summariseRow(row: ConversationRow): ConversationSummary {
  return omitUndefined({
    id: String(row.id || ''),
    title: String(row.title || '新对话'),
    pinned: Boolean(row.pinned),
    messageCount: Number(row.message_count) || 0,
    branchCount: Number(row.branch_count) || 0,
    activeBranchId: row.active_branch_id ? String(row.active_branch_id) : undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}
/** 从行解析消息数组。 */
function parseMessages(row: ConversationRow): unknown[] { return parseJsonArray(row.messages); }
/** 把 DB 行映射为完整对话记录(含消息/分支正文,Date 列转 ISO 串)。 */
function fullRow(row: ConversationRow): ConversationRecord {
  return omitUndefined({
    id: String(row.id || ''),
    title: String(row.title || '新对话'),
    pinned: Boolean(row.pinned),
    messages: parseMessages(row),
    activeBranchId: row.active_branch_id ? String(row.active_branch_id) : undefined,
    branches: parseBranches(row),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}

/** 对话历史的 PG 后端,接口与 FileConversationStore 对齐,按 tenant/user/workspace 隔离。 */
export class PostgresConversationStore {
  private _pool: PgPool | null;
  private _connectionString: string | null;
  private _now: () => Date;

  constructor({ pool = null, connectionString = null, now = () => new Date() }: PostgresConversationStoreOptions = {}) {
    this._pool = pool;
    this._connectionString = connectionString;
    this._now = now;
  }

  /** 取/建连接池(pg 按需 import,缺包给出安装提示)。 */
  async _getPool(): Promise<PgPool> {
    if (this._pool) return this._pool;
    if (!this._connectionString) throw new Error('PostgresConversationStore: pool or connectionString is required');
    let pg: PgModule;
    try { pg = await import('pg') as PgModule; } catch { throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`."); }
    const Pool = pg.default?.Pool || pg.Pool;
    if (!Pool) throw new Error("PostgreSQL backend requires the 'pg' Pool export.");
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** 取池后执行参数化查询。 */
  async _query(text: string, params: unknown[] = []): Promise<PgResult> { const pool = await this._getPool(); return pool.query(text, params); }

  /** 列出该 tenant/user/workspace 的对话摘要(更新时间倒序)。 */
  async list(trustedRoot: unknown, context: ConversationContext = {}): Promise<ConversationSummary[]> {
    const r = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count,
              COALESCE(jsonb_array_length(branches), 0) AS branch_count, active_branch_id,
              created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 ORDER BY updated_at DESC`,
      [...ownerParams(context), workspaceKey(trustedRoot)],
    );
    return (r.rows || []).map((row) => summariseRow(row as ConversationRow));
  }

  /** 标题 ILIKE 搜索 + 分页,返回 { items, total };limit 夹在 1~200。 */
  async query(trustedRoot: unknown, context: ConversationContext = {}, { q = '', limit = 30, offset = 0 }: ConversationQueryOptions = {}): Promise<ConversationQueryResult> {
    const [tenantId, userId] = ownerParams(context);
    const wsKey = workspaceKey(trustedRoot);
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const ql = String(q || '').trim();
    const where = ql
      ? `tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND title ILIKE $4`
      : `tenant_id=$1 AND user_id=$2 AND workspace_key=$3`;
    const whereParams: unknown[] = ql ? [tenantId, userId, wsKey, `%${ql}%`] : [tenantId, userId, wsKey];
    const countRes = await this._query(`SELECT COUNT(*)::int AS total FROM conversations WHERE ${where}`, whereParams);
    const totalRow = (countRes.rows && countRes.rows[0]) as ConversationRow | undefined;
    const total = (totalRow && Number(totalRow.total)) || 0;
    const rowsRes = await this._query(
      `SELECT id, title, pinned, jsonb_array_length(messages) AS message_count,
              COALESCE(jsonb_array_length(branches), 0) AS branch_count, active_branch_id,
              created_at, updated_at
       FROM conversations WHERE ${where} ORDER BY updated_at DESC LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
      [...whereParams, lim, off],
    );
    return { items: (rowsRes.rows || []).map((row) => summariseRow(row as ConversationRow)), total };
  }

  /** 返回完整对话记录(含消息/分支正文),可选 limit。 */
  async listFull(trustedRoot: unknown, context: ConversationContext = {}, { limit }: ConversationListFullOptions = {}): Promise<ConversationRecord[]> {
    const hasLimit = typeof limit === 'number';
    const r = await this._query(
      `SELECT id, title, pinned, messages, branches, active_branch_id, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 ORDER BY updated_at DESC${hasLimit ? ' LIMIT $4' : ''}`,
      hasLimit
        ? [...ownerParams(context), workspaceKey(trustedRoot), Math.max(0, limit)]
        : [...ownerParams(context), workspaceKey(trustedRoot)],
    );
    return (r.rows || []).map((row) => fullRow(row as ConversationRow));
  }

  /** 取单个对话完整记录,不存在返回 null。 */
  async get(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): Promise<ConversationRecord | null> {
    const r = await this._query(
      `SELECT id, title, pinned, messages, branches, active_branch_id, created_at, updated_at
       FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [...ownerParams(context), workspaceKey(trustedRoot), cleanConversationId(id)],
    );
    const row = (r.rows && r.rows[0]) as ConversationRow | undefined;
    return row ? fullRow(row) : null;
  }

  /** upsert 对话(按 tenant/user/workspace/id 冲突更新),清洗后写入并返回摘要。 */
  async save(trustedRoot: unknown, conv: ConversationInput, context: ConversationContext = {}): Promise<ConversationSummary> {
    const id = cleanConversationId(conv && conv.id);
    const [tenantId, userId] = ownerParams(context);
    const wsKey = workspaceKey(trustedRoot);
    const now = this._now().toISOString();
    const title = String((conv && conv.title) || '新对话').slice(0, MAX_CONVERSATION_TITLE);
    const pinned = Boolean(conv && conv.pinned);
    const messages = sanitizeConversationMessages(conv && conv.messages);
    const branches = sanitizeConversationBranches(conv && conv.branches);
    const requestedActive = safeOptionalConversationId(conv && conv.activeBranchId);
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
    const row = ((r.rows && r.rows[0]) || {
      id, title, pinned, message_count: messages.length, branch_count: branches.length,
      active_branch_id: activeBranchId, created_at: now, updated_at: now,
    }) as ConversationRow;
    return summariseRow(row);
  }

  /** 删除单个对话,返回是否真的删除。 */
  async remove(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): Promise<boolean> {
    const r = await this._query(
      `DELETE FROM conversations WHERE tenant_id=$1 AND user_id=$2 AND workspace_key=$3 AND id=$4`,
      [...ownerParams(context), workspaceKey(trustedRoot), cleanConversationId(id)],
    );
    return (r.rowCount || 0) > 0;
  }

  /** 关闭连接池。 */
  async close(): Promise<void> { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** 工厂:构造 PG 后端对话存储。 */
export function createPostgresConversationStore(options: PostgresConversationStoreOptions = {}): PostgresConversationStore {
  return new PostgresConversationStore(options);
}
