// 按用户持久化对话历史(文件后端)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把每个对话存为 <root>/.AgentCowork/conversations/<tenant>/<user>/<id>.json,
//       提供 list/query/listFull/get/save/remove;对 id/标题/分支/消息做白名单清洗与
//       体量上限,防止越权目录穿越与文档膨胀。后端:本地文件系统(JSON 文档)。
// 依赖:仅标准库(fs/path)。
// 导出:FileConversationStore(类) · createConversationStore(工厂)。
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanConversationId,
  MAX_CONVERSATION_TITLE,
  safeOptionalConversationId,
  sanitizeConversationBranches,
  sanitizeConversationMessages,
} from './conversation-sanitizers.js';
import type {
  ConversationContext,
  ConversationInput,
  ConversationListFullOptions,
  ConversationQueryOptions,
  ConversationQueryResult,
  ConversationRecord,
  ConversationStoreOptions,
  ConversationSummary,
} from './conversation-types.js';

// Per-user conversation persistence. Each conversation is one JSON document under
//   <trustedRoot>/.AgentCowork/conversations/<tenantId>/<userId>/<convId>.json
// so a signed-in user's history follows their account across devices/instances
// that share the same data root. Guests (tenant_local/user_local) get the same
// treatment, which keeps the desktop's offline experience intact.
const ROOT_DIR = '.AgentCowork';
const CONV_DIR = 'conversations';
const MAX_BYTES = 1024 * 1024; // hard cap per conversation document

export type {
  ConversationBranch,
  ConversationContext,
  ConversationInput,
  ConversationListFullOptions,
  ConversationQueryOptions,
  ConversationQueryResult,
  ConversationRecord,
  ConversationStoreOptions,
  ConversationSummary,
} from './conversation-types.js';

/** 把 tenant/user 段清洗为文件系统安全字符串(防目录穿越)。 */
function normaliseSegment(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  if (!text) return fallback;
  // Keep only filesystem-safe characters; collapse the rest so a hostile
  // tenant/user id can never escape the conversations directory.
  const safe = text.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 96);
  return safe || fallback;
}

/** 校验并解析受信根目录(为空抛错)。 */
function ensureTrustedRoot(trustedRoot: unknown): string {
  const root = String(trustedRoot || '').trim();
  if (!root) throw new Error('trustedRoot is required');
  return path.resolve(root);
}

/** 拼出某租户/用户的对话目录路径。 */
function userDir(trustedRoot: unknown, context: ConversationContext = {}): string {
  const tenant = normaliseSegment(context.tenantId, 'tenant_local');
  const user = normaliseSegment(context.userId, 'user_local');
  return path.join(ensureTrustedRoot(trustedRoot), ROOT_DIR, CONV_DIR, tenant, user);
}

/** 把完整对话记录压成列表用的摘要(含消息/分支计数)。 */
function summarise(conv: ConversationRecord): ConversationSummary {
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
  now: () => Date;

  constructor({ now = () => new Date() }: ConversationStoreOptions = {}) {
    this.now = now;
  }

  /** 读取用户目录下全部对话文档,经 mapper 映射后按 updatedAt 倒序返回(跳过损坏文件)。 */
  _readDir<T>(trustedRoot: unknown, context: ConversationContext, mapper: (conv: ConversationRecord) => T): T[] {
    const dir = userDir(trustedRoot, context);
    if (!fs.existsSync(dir)) return [];
    const out: T[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ConversationRecord;
        if (conv && conv.id) out.push(mapper(conv));
      } catch {
        /* skip corrupt document */
      }
    }
    out.sort((a, b) => {
      const left = a as { updatedAt?: unknown };
      const right = b as { updatedAt?: unknown };
      return String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
    });
    return out;
  }

  /** 列出该用户的对话摘要(按更新时间倒序)。 */
  list(trustedRoot: unknown, context: ConversationContext = {}): ConversationSummary[] {
    return this._readDir(trustedRoot, context, summarise);
  }

  // Paginated + title-searched summaries: { items, total }.
  /** 按标题搜索 + 分页返回摘要,limit 夹在 1~200。 */
  query(trustedRoot: unknown, context: ConversationContext = {}, { q = '', limit = 30, offset = 0 }: ConversationQueryOptions = {}): ConversationQueryResult {
    const all = this._readDir(trustedRoot, context, summarise);
    const ql = String(q || '').trim().toLowerCase();
    const filtered = ql ? all.filter((c) => (c.title || '').toLowerCase().includes(ql)) : all;
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    return { items: filtered.slice(off, off + lim), total: filtered.length };
  }

  /** 返回完整对话记录(含消息正文),可选 limit 截断。 */
  listFull(trustedRoot: unknown, context: ConversationContext = {}, { limit }: ConversationListFullOptions = {}): ConversationRecord[] {
    const all = this._readDir(trustedRoot, context, (conv) => conv);
    return typeof limit === 'number' ? all.slice(0, Math.max(0, limit)) : all;
  }

  /** 读取单个对话完整记录,不存在或损坏返回 null。 */
  get(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): ConversationRecord | null {
    const file = path.join(userDir(trustedRoot, context), `${cleanConversationId(id)}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as ConversationRecord;
    } catch {
      return null;
    }
  }

  /** 落盘对话(清洗 + 选活跃分支 + 保留 createdAt);超字节上限则进一步裁剪消息而非拒绝。 */
  save(trustedRoot: unknown, conv: ConversationInput, context: ConversationContext = {}): ConversationSummary {
    const id = cleanConversationId(conv && conv.id);
    const dir = userDir(trustedRoot, context);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    const existing = fs.existsSync(file) ? this.get(trustedRoot, id, context) : null;
    const now = this.now().toISOString();
    const branches = sanitizeConversationBranches(conv && conv.branches);
    const requestedActive = safeOptionalConversationId(conv && conv.activeBranchId);
    const activeBranchId = branches.some((branch) => branch.id === requestedActive)
      ? requestedActive
      : branches[0]?.id;
    const record: ConversationRecord = {
      id,
      title: String((conv && conv.title) || '新对话').slice(0, MAX_CONVERSATION_TITLE),
      pinned: Boolean(conv && conv.pinned),
      messages: sanitizeConversationMessages(conv && conv.messages),
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

  /** 删除单个对话文档,返回是否真的删除。 */
  remove(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): boolean {
    const file = path.join(userDir(trustedRoot, context), `${cleanConversationId(id)}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }
}

/** 工厂:返回文件后端对话存储(PG 后端由 server 在 KCW_STORE=postgres 时另选)。 */
export function createConversationStore({ backend = 'file', now }: ConversationStoreOptions = {}): FileConversationStore {
  // Postgres adapter (createPostgresConversationStore) mirrors this interface and
  // is selected by the server when KCW_STORE=postgres.
  void backend;
  return new FileConversationStore({ now });
}
