// 按用户持久化对话历史(文件后端)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把每个对话存为 <root>/.AgentCowork/conversations/<tenant>/<user>/<id>.json,
//       提供 list/query/listFull/get/save/remove;对 id/标题/分支/消息做白名单清洗与
//       体量上限,防止越权目录穿越与文档膨胀。后端:本地文件系统(JSON 文档)。
// 依赖:仅标准库(fs/path)。
// 导出:FileConversationStore(类) · createConversationStore(工厂)。
import fs from 'node:fs';
import path from 'node:path';

// Per-user conversation persistence. Each conversation is one JSON document under
//   <trustedRoot>/.AgentCowork/conversations/<tenantId>/<userId>/<convId>.json
// so a signed-in user's history follows their account across devices/instances
// that share the same data root. Guests (tenant_local/user_local) get the same
// treatment, which keeps the desktop's offline experience intact.
// @ts-check

const ROOT_DIR = '.AgentCowork';
const CONV_DIR = 'conversations';
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_BYTES = 1024 * 1024; // hard cap per conversation document
const MAX_TITLE = 200;

/**
 * @typedef {{ tenantId?: unknown, userId?: unknown }} ConversationContext
 * @typedef {{ id: string, title: string, parentBranchId?: string, baseMessageId?: string, createdAt?: string, messages: unknown[] }} ConversationBranch
 * @typedef {{ id?: unknown, title?: unknown, pinned?: unknown, messages?: unknown, activeBranchId?: unknown, branches?: unknown, createdAt?: unknown, updatedAt?: unknown }} ConversationInput
 * @typedef {{ id: string, title: string, pinned: boolean, messages: unknown[], activeBranchId?: string, branches?: ConversationBranch[], createdAt?: unknown, updatedAt?: unknown }} ConversationRecord
 * @typedef {{ id: string, title: string, pinned: boolean, messageCount: number, branchCount: number, activeBranchId?: string, createdAt?: unknown, updatedAt?: unknown }} ConversationSummary
 * @typedef {{ q?: unknown, limit?: unknown, offset?: unknown }} ConversationQueryOptions
 * @typedef {{ items: ConversationSummary[], total: number }} ConversationQueryResult
 * @typedef {{ limit?: number }} ConversationListFullOptions
 * @typedef {{ backend?: string, now?: () => Date }} ConversationStoreOptions
 */

/** 把 tenant/user 段清洗为文件系统安全字符串(防目录穿越)。 @param {unknown} value @param {string} fallback @returns {string} */
function normaliseSegment(value, fallback) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  // Keep only filesystem-safe characters; collapse the rest so a hostile
  // tenant/user id can never escape the conversations directory.
  const safe = text.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return safe || fallback;
}

/** 校验并解析受信根目录(为空抛错)。 @param {unknown} trustedRoot @returns {string} */
function ensureTrustedRoot(trustedRoot) {
  const root = String(trustedRoot || '').trim();
  if (!root) throw new Error('trustedRoot is required');
  return path.resolve(root);
}

/** 拼出某租户/用户的对话目录路径。 @param {unknown} trustedRoot @param {ConversationContext} [context] @returns {string} */
function userDir(trustedRoot, context = {}) {
  const tenant = normaliseSegment(context.tenantId, 'tenant_local');
  const user = normaliseSegment(context.userId, 'user_local');
  return path.join(ensureTrustedRoot(trustedRoot), ROOT_DIR, CONV_DIR, tenant, user);
}

/** 校验对话 id 合法性(白名单正则),非法抛错。 @param {unknown} id @returns {string} */
function cleanId(id) {
  const text = String(id || '').trim();
  if (!ID_RE.test(text)) throw new Error('invalid conversation id');
  return text;
}

/** 仅保留最近 200 条消息,防止单文档膨胀。 @param {unknown} messages @returns {unknown[]} */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Cap the stored history so a runaway conversation can't blow the byte limit.
  return messages.slice(-200);
}

/** 校验可选 id(分支/baseMessage),非法返回空串而非抛错。 @param {unknown} value @returns {string} */
function safeOptionalId(value) {
  const text = String(value || '').trim();
  return ID_RE.test(text) ? text : '';
}

/** 清洗分支列表:限 12 条,补默认 id/标题,逐分支裁剪消息。 @param {unknown} branches @returns {ConversationBranch[]} */
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

/** 把完整对话记录压成列表用的摘要(含消息/分支计数)。 @param {ConversationRecord} conv @returns {ConversationSummary} */
function summarise(conv) {
  return {
    id: conv.id,
    title: conv.title || '新对话',
    pinned: Boolean(conv.pinned),
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    branchCount: Array.isArray(conv.branches) ? conv.branches.length : 0,
    activeBranchId: conv.activeBranchId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
}

/** 基于文件系统的对话存储:每个对话一份 JSON 文档,按 tenant/user 分目录。 */
export class FileConversationStore {
  /** @param {ConversationStoreOptions} [options] */
  constructor({ now = () => new Date() } = {}) {
    /** @type {() => Date} */
    this.now = now;
  }

  /** 读取用户目录下全部对话文档,经 mapper 映射后按 updatedAt 倒序返回(跳过损坏文件)。 @template T @param {unknown} trustedRoot @param {ConversationContext} context @param {(conv: ConversationRecord) => T} mapper @returns {T[]} */
  _readDir(trustedRoot, context, mapper) {
    const dir = userDir(trustedRoot, context);
    if (!fs.existsSync(dir)) return [];
    /** @type {T[]} */
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const conv = /** @type {ConversationRecord} */ (JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
        if (conv && conv.id) out.push(mapper(conv));
      } catch {
        /* skip corrupt document */
      }
    }
    out.sort((a, b) => {
      const left = /** @type {{ updatedAt?: unknown }} */ (a);
      const right = /** @type {{ updatedAt?: unknown }} */ (b);
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });
    return out;
  }

  /** 列出该用户的对话摘要(按更新时间倒序)。 @param {unknown} trustedRoot @param {ConversationContext} [context] @returns {ConversationSummary[]} */
  list(trustedRoot, context = {}) {
    return this._readDir(trustedRoot, context, summarise);
  }

  // Paginated + title-searched summaries: { items, total }.
  /** 按标题搜索 + 分页返回摘要,limit 夹在 1~200。 @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationQueryOptions} [options] @returns {ConversationQueryResult} */
  query(trustedRoot, context = {}, { q = '', limit = 30, offset = 0 } = {}) {
    const all = this._readDir(trustedRoot, context, summarise);
    const ql = String(q || '').trim().toLowerCase();
    const filtered = ql ? all.filter((c) => (c.title || '').toLowerCase().includes(ql)) : all;
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    return { items: filtered.slice(off, off + lim), total: filtered.length };
  }

  /** 返回完整对话记录(含消息正文),可选 limit 截断。 @param {unknown} trustedRoot @param {ConversationContext} [context] @param {ConversationListFullOptions} [options] @returns {ConversationRecord[]} */
  listFull(trustedRoot, context = {}, { limit } = {}) {
    const all = this._readDir(trustedRoot, context, (conv) => conv);
    return typeof limit === 'number' ? all.slice(0, Math.max(0, limit)) : all;
  }

  /** 读取单个对话完整记录,不存在或损坏返回 null。 @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {ConversationRecord | null} */
  get(trustedRoot, id, context = {}) {
    const file = path.join(userDir(trustedRoot, context), `${cleanId(id)}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return /** @type {ConversationRecord} */ (JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** 落盘对话(清洗 + 选活跃分支 + 保留 createdAt);超字节上限则进一步裁剪消息而非拒绝。 @param {unknown} trustedRoot @param {ConversationInput} conv @param {ConversationContext} [context] @returns {ConversationSummary} */
  save(trustedRoot, conv, context = {}) {
    const id = cleanId(conv && conv.id);
    const dir = userDir(trustedRoot, context);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const existing = fs.existsSync(file) ? this.get(trustedRoot, id, context) : null;
    const now = this.now().toISOString();
    const branches = sanitizeBranches(conv && conv.branches);
    const requestedActive = safeOptionalId(conv && conv.activeBranchId);
    const activeBranchId = branches.some((branch) => branch.id === requestedActive)
      ? requestedActive
      : branches[0]?.id;
    const record = {
      id,
      title: String((conv && conv.title) || '新对话').slice(0, MAX_TITLE),
      pinned: Boolean(conv && conv.pinned),
      messages: sanitizeMessages(conv && conv.messages),
      ...(branches.length ? { activeBranchId, branches } : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    let body = JSON.stringify(record);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
      // Trim history further until it fits rather than rejecting the save.
      record.messages = record.messages.slice(-50);
      body = JSON.stringify(record);
    }
    fs.writeFileSync(file, body, 'utf8');
    return summarise(record);
  }

  /** 删除单个对话文档,返回是否真的删除。 @param {unknown} trustedRoot @param {unknown} id @param {ConversationContext} [context] @returns {boolean} */
  remove(trustedRoot, id, context = {}) {
    const file = path.join(userDir(trustedRoot, context), `${cleanId(id)}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}

/** 工厂:返回文件后端对话存储(PG 后端由 server 在 KCW_STORE=postgres 时另选)。 @param {ConversationStoreOptions} [options] @returns {FileConversationStore} */
export function createConversationStore({ backend = 'file', now } = {}) {
  // Postgres adapter (createPostgresConversationStore) mirrors this interface and
  // is selected by the server when KCW_STORE=postgres.
  void backend;
  return new FileConversationStore({ now });
}
