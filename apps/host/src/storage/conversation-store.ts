// 按用户持久化对话历史(文件后端)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把每个对话存为 <root>/.AgentCowork/conversations/<owner-hash>/<id>.json,
//       提供 list/query/listFull/get/save/remove;对 id/标题/分支/消息做白名单清洗与
//       体量上限,防止越权目录穿越与文档膨胀。后端:本地文件系统(JSON 文档)。
// 依赖:仅标准库(fs/path)。
// 导出:FileConversationStore(类) · createConversationStore(工厂)。
import {
  cleanConversationId,
  MAX_CONVERSATION_TITLE,
  safeOptionalConversationId,
  sanitizeConversationBranches,
  sanitizeConversationMessages,
} from './conversation-sanitizers.js';
import { omitUndefined } from '../util/object.js';
import { AtRestKeyError, openAtRest, sealAtRest } from '../security/at-rest.js';
import { ConversationFileBoundary, ConversationPathError } from './conversation-file-boundary.js';
import { conversationOwnerDirectory, legacyLocalConversationSegments } from './conversation-owner.js';
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

// 每个对话是一份 JSON 文档,按精确 tenant/user tuple 的版本化哈希分目录;共享数据根时仍可随账号保留。
// 访客也使用同一路径模型,保证桌面离线体验不退化。
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
/** 新 owner 目录优先；legacy 只作为精确 local/local 的受限兼容读取面。 */
function userDirs(files: ConversationFileBoundary, context: ConversationContext = {}): string[] {
  const current = files.ownerDirectory(conversationOwnerDirectory(context));
  const segments = legacyLocalConversationSegments(context);
  const legacy = segments ? files.legacyDirectory(segments) : null;
  return legacy && legacy !== current ? [current, legacy] : [current];
}

function isInfrastructureError(error: unknown): boolean {
  return error instanceof AtRestKeyError || error instanceof ConversationPathError;
}

/** Parse one persisted document and reject records that cannot belong to the requested file. */
function parseConversationRecord(text: string, expectedId: string): ConversationRecord {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid persisted conversation record');
  const record = parsed as Record<string, unknown>;
  if (
    record.id !== expectedId
    || typeof record.title !== 'string'
    || !Array.isArray(record.messages)
    || (Object.hasOwn(record, 'pinned') && typeof record.pinned !== 'boolean')
    || (Object.hasOwn(record, 'activeBranchId') && typeof record.activeBranchId !== 'string')
    || (Object.hasOwn(record, 'branches') && !Array.isArray(record.branches))
  ) {
    throw new Error('Invalid persisted conversation record');
  }
  return record as ConversationRecord;
}

function readConversationFile(
  files: ConversationFileBoundary,
  file: string,
  expectedId: string,
): ConversationRecord | null | undefined {
  const text = files.readFile(file);
  if (text === null) return undefined;
  files.assertDirectory(files.securityDirectory);
  const opened = openAtRest(text, files.securityDirectory);
  files.assertDirectory(files.securityDirectory);
  return opened === null ? null : parseConversationRecord(opened, expectedId);
}

/** 把完整对话记录压成列表用的摘要(含消息/分支计数)。 */
function summarise(conv: ConversationRecord): ConversationSummary {
  return omitUndefined({
    id: conv.id,
    title: conv.title || '新对话',
    pinned: Boolean(conv.pinned),
    messageCount: Array.isArray(conv.messages) ? conv.messages.length : 0,
    branchCount: Array.isArray(conv.branches) ? conv.branches.length : 0,
    activeBranchId: conv.activeBranchId,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  });
}

/** 基于文件系统的对话存储:每个对话一份 JSON 文档,按不可碰撞 owner 哈希分目录。 */
export class FileConversationStore {
  now: () => Date;

  constructor({ now = () => new Date() }: ConversationStoreOptions = {}) {
    this.now = now;
  }

  /** 读取用户目录下全部对话文档,经 mapper 映射后按 updatedAt 倒序返回(跳过损坏文件)。 */
  _readDir<T>(trustedRoot: unknown, context: ConversationContext, mapper: (conv: ConversationRecord) => T): T[] {
    const files = new ConversationFileBoundary(trustedRoot);
    const out: T[] = [];
    const seenFiles = new Set<string>();
    for (const dir of userDirs(files, context)) {
      const names = files.readDirectory(dir);
      if (!names) continue;
      for (const name of names) {
        if (!name.endsWith('.json') || seenFiles.has(name)) continue;
        seenFiles.add(name); // 新目录中的同名文件即使损坏,也不回退到旧副本。
        try {
          const expectedId = cleanConversationId(name.slice(0, -'.json'.length));
          const record = readConversationFile(files, files.file(dir, name), expectedId);
          if (!record) continue; // 消失、损坏或单条密文认证失败时跳过。
          out.push(mapper(record));
        } catch (error) {
          if (isInfrastructureError(error)) throw error;
          /* 跳过损坏的对话文档。 */
        }
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

  private _get(
    files: ConversationFileBoundary,
    id: string,
    context: ConversationContext,
  ): ConversationRecord | null {
    const name = `${id}.json`;
    for (const dir of userDirs(files, context)) {
      try {
        const record = readConversationFile(files, files.file(dir, name), id);
        if (record === undefined) continue;
        return record;
      } catch (error) {
        if (isInfrastructureError(error)) throw error;
        return null;
      }
    }
    return null;
  }

  /** 读取单个对话完整记录,不存在或损坏返回 null。 */
  get(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): ConversationRecord | null {
    const cleanId = cleanConversationId(id);
    return this._get(new ConversationFileBoundary(trustedRoot), cleanId, context);
  }

  /** 落盘对话(清洗 + 选活跃分支 + 保留 createdAt);超字节上限则进一步裁剪消息而非拒绝。 */
  save(trustedRoot: unknown, conv: ConversationInput, context: ConversationContext = {}): ConversationSummary {
    const id = cleanConversationId(conv && conv.id);
    const files = new ConversationFileBoundary(trustedRoot);
    const directories = userDirs(files, context);
    const dir = directories[0] as string;
    const file = files.file(dir, `${id}.json`);
    const existing = this._get(files, id, context);
    const existingFileIsUnreadable = existing === null
      && directories.some((candidateDir) => files.fileExists(files.file(candidateDir, `${id}.json`)));
    if (existingFileIsUnreadable) {
      throw new Error('Existing conversation cannot be decrypted or parsed; refusing to overwrite');
    }
    const now = this.now().toISOString();
    const branches = sanitizeConversationBranches(conv && conv.branches);
    const requestedActive = safeOptionalConversationId(conv && conv.activeBranchId);
    const activeBranchId = branches.some((branch) => branch.id === requestedActive)
      ? requestedActive
      : branches[0]?.id;
    const record: ConversationRecord = omitUndefined({
      id,
      title: String((conv && conv.title) || '新对话').slice(0, MAX_CONVERSATION_TITLE),
      pinned: Boolean(conv && conv.pinned),
      messages: sanitizeConversationMessages(conv && conv.messages),
      ...(branches.length ? omitUndefined({ activeBranchId, branches }) : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    let body = JSON.stringify(record);
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
      // 超限时进一步裁剪历史而不是直接拒绝保存。(按明文正文量算,不含加密膨胀)
      record.messages = record.messages.slice(-50);
      body = JSON.stringify(record);
    }
    files.guardMutation(files.securityDirectory);
    const sealed = sealAtRest(body, files.securityDirectory);
    files.guardMutation(files.securityDirectory);
    files.writeFile(file, sealed);
    return summarise(record);
  }

  /** 删除单个对话文档,返回是否真的删除。 */
  remove(trustedRoot: unknown, id: unknown, context: ConversationContext = {}): boolean {
    const name = `${cleanConversationId(id)}.json`;
    const files = new ConversationFileBoundary(trustedRoot);
    let deleted = false;
    // legacy 先删:若旧副本删除失败,保留 current 权威副本,避免错误后旧正文重新显现。
    for (const dir of userDirs(files, context).reverse()) {
      if (files.removeFile(files.file(dir, name))) deleted = true;
    }
    return deleted;
  }
}

/** 工厂:返回文件后端对话存储(PG 后端由 server 在 ACW_STORE=postgres 时另选)。 */
export function createConversationStore({ backend = 'file', now }: ConversationStoreOptions = {}): FileConversationStore {
  // Postgres 适配器保持同接口,由 server 在 ACW_STORE=postgres 时选择。
  void backend;
  return new FileConversationStore(omitUndefined({ now }));
}
