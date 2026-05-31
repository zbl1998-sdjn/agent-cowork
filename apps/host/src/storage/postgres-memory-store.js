// 跨会话记忆(事实 + 笔记)的 PostgreSQL 适配(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:SqliteMemoryStore 的多实例 PG 镜像——按租户读写 memory_facts/memory_notes,
//       渲染主记忆文本与 system 注入块,做 key/value/scope 清洗、UTF-8 字节封顶。
// 依赖:仅标准库(crypto);pg 运行时按需 import。后端:PostgreSQL(memory_facts/notes 表)。
// 导出:PostgresMemoryStore(类) · createPostgresMemoryStore(工厂)。
//
// PostgreSQL adapter for cross-session memory (facts + notes) — multi-instance
// mirror of SqliteMemoryStore. Async; `pg` lazily/optionally imported. Tenant
// -scoped. Tests inject a mock pool.
// @ts-check
import crypto from 'node:crypto';

/**
 * @typedef {'project' | 'user' | 'session'} MemoryScope
 * @typedef {{ key?: unknown, value?: unknown, scope?: unknown }} MemoryFactInput
 * @typedef {{ key: string, value: string, scope: MemoryScope }} MemoryFact
 * @typedef {{ traceId?: unknown, tenantId?: unknown, userId?: unknown }} MemoryContext
 * @typedef {{ maxBytes?: number, context?: MemoryContext }} MemoryQueryOptions
 * @typedef {{ rows?: unknown[], rowCount?: number | null }} PgResult
 * @typedef {{ query(text: string, params?: unknown[]): Promise<PgResult>, end?: () => Promise<unknown> }} PgPool
 * @typedef {{ pool?: PgPool | null, connectionString?: string | null, now?: () => Date }} PostgresMemoryStoreOptions
 * @typedef {{ id: string, name: string, size: number, created_at: string, updated_at: string }} MemoryNoteRow
 * @typedef {{ body: string }} MemoryBodyRow
 * @typedef {{ id: string, created_at: string }} MemoryExistingNoteRow
 */

const MEMORY_HEADER = '# Agent Cowork 项目记忆\n\n这份文件记录 Kimi 在本工作区需要长期记住的事实。每次对话开始时被注入到 system 段。\n\n';
const MAX_MEMORY_BYTES = 64 * 1024;
const MAX_FACT_KEY_LENGTH = 96;
const MAX_FACT_VALUE_LENGTH = 4 * 1024;
const NOTE_NAME_RE = /^[a-z0-9_.-]{1,96}\.md$/i;

/** @param {unknown} v @param {string} fb @returns {string} */
function clampId(v, fb) { const t = String(v || '').trim(); return t ? (t.length > 96 ? t.slice(0, 96) : t) : fb; }
/** @param {unknown} v @returns {string} */
const normTenant = (v) => clampId(v, 'tenant_local');
/** @param {unknown} v @returns {string} */
const normUser = (v) => clampId(v, 'user_local');
/** 生成带前缀的记忆条目 id。 @param {string} prefix @returns {string} */
function memId(prefix) { return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`; }

/** 按 UTF-8 字节上限截断文本,且不切断多字节字符。 @param {unknown} text @param {number} maxBytes @returns {string} */
function clipUtf8(text, maxBytes) {
  if (!text) return '';
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString('utf8');
}
/** 校验事实 key:非空、不超长、仅允许字母数字中文及少量符号。 @param {unknown} v @returns {string} */
function cleanFactKey(v) {
  const t = String(v || '').trim();
  if (!t) throw new Error('memory fact key is required');
  if (t.length > MAX_FACT_KEY_LENGTH) throw new Error(`memory fact key too long; max ${MAX_FACT_KEY_LENGTH}`);
  if (!/^[\w一-龥 .,:_/()\-]+$/u.test(t)) throw new Error('memory fact key contains invalid characters');
  return t;
}
/** 校验事实 value:归一换行、去空白、非空且不超长。 @param {unknown} v @returns {string} */
function cleanFactValue(v) {
  const t = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  if (!t) throw new Error('memory fact value is required');
  if (t.length > MAX_FACT_VALUE_LENGTH) throw new Error(`memory fact value too long; max ${MAX_FACT_VALUE_LENGTH}`);
  return t;
}
/** 归一记忆作用域,非法回落为 project。 @param {unknown} v @returns {MemoryScope} */
function cleanScope(v) {
  const t = String(v || 'project').trim().toLowerCase();
  return /** @type {MemoryScope} */ (['project', 'user', 'session'].includes(t) ? t : 'project');
}
/** 读取 JSON 列:字符串则 parse,否则原样返回(兼容 jsonb 直返对象)。 @param {unknown} row @param {string} col @returns {unknown} */
function parseCol(row, col) {
  if (!row) return null;
  const r = /** @type {Record<string, unknown>} */ (row)[col];
  return typeof r === 'string' ? JSON.parse(r) : r;
}

/** 跨会话记忆的 PG 后端:按租户存取事实/笔记,并渲染 system 注入用的记忆块。 */
export class PostgresMemoryStore {
  /** @param {PostgresMemoryStoreOptions} [options] */
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
    if (!this._connectionString) throw new Error('PostgresMemoryStore: pool or connectionString is required');
    let pg;
    try { pg = await import('pg'); } catch { throw new Error("PostgreSQL backend requires the 'pg' package — run `npm i pg`."); }
    const Pool = pg.default ? pg.default.Pool : pg.Pool;
    const pool = new Pool({ connectionString: this._connectionString, max: Number(process.env.PGPOOL_MAX || 20) });
    this._pool = pool;
    return pool;
  }

  /** 取池后执行参数化查询。 @param {string} text @param {unknown[]} [params] @returns {Promise<PgResult>} */
  async _query(text, params = []) { const pool = await this._getPool(); return pool.query(text, params); }

  /** 把该租户全部事实渲染成主记忆 Markdown 文本(带头部,字节封顶)。 @param {unknown} trustedRoot @param {MemoryContext} [context] @returns {Promise<string>} */
  async readMainMemory(trustedRoot, context = {}) {
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(
      `SELECT fact_json FROM memory_facts WHERE tenant_id=$1 ORDER BY created_at ASC, id ASC`,
      [tenantId],
    );
    if (!r.rows || !r.rows.length) return '';
    const lines = r.rows.map((row) => {
      const f = /** @type {MemoryFact} */ (parseCol(row, 'fact_json'));
      return `- **${f.key}** (${f.scope}): ${f.value}\n`;
    });
    return clipUtf8(`${MEMORY_HEADER}${lines.join('')}`, MAX_MEMORY_BYTES);
  }

  /** 列出该租户的记忆笔记元信息(name/size/modifiedAt/虚拟 path)。 @param {unknown} trustedRoot @param {MemoryContext} [context] @returns {Promise<Array<{ name: string, size: number, modifiedAt: string, path: string }>>} */
  async listMemoryNotes(trustedRoot, context = {}) {
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(
      `SELECT id, name, size, created_at, updated_at FROM memory_notes WHERE tenant_id=$1 ORDER BY name ASC`,
      [tenantId],
    );
    return (r.rows || []).map((row) => {
      const note = /** @type {MemoryNoteRow} */ (row);
      return {
        name: note.name,
        size: Number(note.size) || 0,
        modifiedAt: note.updated_at || note.created_at,
        path: `postgres://memory_notes/${note.id}`,
      };
    });
  }

  /** 读取单篇笔记正文(校验文件名),不存在返回 null。 @param {unknown} trustedRoot @param {string} noteName @param {MemoryContext} [context] @returns {Promise<string | null>} */
  async readMemoryNote(trustedRoot, noteName, context = {}) {
    if (!NOTE_NAME_RE.test(String(noteName || ''))) throw new Error('Invalid memory note name');
    const tenantId = normTenant(context.tenantId);
    const r = await this._query(`SELECT body FROM memory_notes WHERE tenant_id=$1 AND name=$2`, [tenantId, noteName]);
    const row = r.rows && r.rows[0];
    return row ? (/** @type {MemoryBodyRow} */ (row)).body : null;
  }

  /** upsert 单篇笔记(正文字节封顶、保留首次 createdAt),返回其虚拟路径。 @param {unknown} trustedRoot @param {string} noteName @param {unknown} body @param {MemoryContext} [context] @returns {Promise<string>} */
  async writeMemoryNote(trustedRoot, noteName, body, context = {}) {
    if (!NOTE_NAME_RE.test(String(noteName || ''))) throw new Error('Invalid memory note name');
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const existing = await this._query(`SELECT id, created_at FROM memory_notes WHERE tenant_id=$1 AND name=$2`, [tenantId, noteName]);
    const prev = /** @type {MemoryExistingNoteRow | undefined} */ (existing.rows && existing.rows[0]);
    const id = (prev && prev.id) || memId('memnote');
    const now = this._now().toISOString();
    const safeBody = clipUtf8(String(body == null ? '' : body), MAX_MEMORY_BYTES);
    const note = { id, name: noteName, size: Buffer.byteLength(safeBody, 'utf8'), createdAt: (prev && prev.created_at) || now, updatedAt: now };
    await this._query(
      `INSERT INTO memory_notes (id, tenant_id, user_id, trace_id, name, body, size, created_at, updated_at, note_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id, name) DO UPDATE SET
         user_id=EXCLUDED.user_id, trace_id=EXCLUDED.trace_id, body=EXCLUDED.body,
         size=EXCLUDED.size, updated_at=EXCLUDED.updated_at, note_json=EXCLUDED.note_json`,
      [id, tenantId, userId, context.traceId || null, noteName, safeBody, note.size, note.createdAt, note.updatedAt, JSON.stringify(note)],
    );
    return `postgres://memory_notes/${id}`;
  }

  /** 追加一条记忆事实(清洗 key/value/scope 后插入),返回虚拟路径与规范化事实。 @param {unknown} trustedRoot @param {MemoryFactInput} fact @param {MemoryContext} [context] @returns {Promise<{ file: string, fact: MemoryFact }>} */
  async appendMemoryFact(trustedRoot, fact, context = {}) {
    const key = cleanFactKey(fact && fact.key);
    const value = cleanFactValue(fact && fact.value);
    const scope = cleanScope(fact && fact.scope);
    const tenantId = normTenant(context.tenantId);
    const userId = normUser(context.userId);
    const id = memId('memfact');
    const now = this._now().toISOString();
    const stored = { id, key, value, scope, createdAt: now };
    await this._query(
      `INSERT INTO memory_facts (id, tenant_id, user_id, trace_id, key, value, scope, created_at, updated_at, fact_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, tenantId, userId, context.traceId || null, key, value, scope, now, now, JSON.stringify(stored)],
    );
    return { file: `postgres://memory_facts/${id}`, fact: { key, value, scope } };
  }

  /** 构造注入 system 段的记忆块(主记忆按 maxBytes 夹紧后裁切;空则返回空串)。 @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {Promise<string>} */
  async buildMemorySystemBlock(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const main = await this.readMainMemory(trustedRoot, context);
    if (!main.trim()) return '';
    return clipUtf8(main, Math.max(512, Math.min(MAX_MEMORY_BYTES, maxBytes))).trim();
  }

  /** 加载完整记忆上下文:system 块 + 笔记清单 + 是否启用/字节数。 @param {unknown} trustedRoot @param {MemoryQueryOptions} [options] @returns {Promise<{ enabled: boolean, bytes: number, text: string, notes: Array<{ name: string, size: number, modifiedAt: string }> }>} */
  async loadMemoryContext(trustedRoot, { maxBytes = 4096, context = {} } = {}) {
    const block = await this.buildMemorySystemBlock(trustedRoot, { maxBytes, context });
    const notes = (await this.listMemoryNotes(trustedRoot, context)).map((n) => ({ name: n.name, size: n.size, modifiedAt: n.modifiedAt }));
    return { enabled: Boolean(block), bytes: Buffer.byteLength(block, 'utf8'), text: block, notes };
  }

  /** 关闭连接池。 @returns {Promise<void>} */
  async close() { if (this._pool && typeof this._pool.end === 'function') await this._pool.end(); }
}

/** 工厂:构造 PG 后端记忆存储。 @param {PostgresMemoryStoreOptions} [options] @returns {PostgresMemoryStore} */
export function createPostgresMemoryStore(options = {}) {
  return new PostgresMemoryStore(options);
}
