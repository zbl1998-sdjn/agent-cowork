// 主题知识库(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:装「对话结束自动提炼出的主题知识条目」——独立于手工 profile items(生命周期不同:
//       自动写入、置信度门控、待确认队列)。落 <root>/.AgentCowork/knowledge.json,提供
//       upsert(DLP → 按 主题+标题 去重合并/supersede → 置信度门 active/pending → per-scope
//       容量淘汰)、list(可按状态)、setStatus(批准 pending)。召回侧(Phase 3)按相关性挑选注入。
// 安全:每条先过 decideMemoryDlp,含密钥/敏感一律不入库;复用 safeWriteSync 的 at-rest 封装。
// 依赖:L0 无;同层 memory-utils(路径/写入/id)、memory-dlp-guard(DLP)。
import { decideMemoryDlp } from './memory-dlp-guard.js';
import { ensureTrustedRoot, memoryDir, memoryId, safeReadSync, safeWriteSync } from './memory-utils.js';
import path from 'node:path';
import type { MemoryScope } from './memory-utils.js';

const KNOWLEDGE_FILE = 'knowledge.json';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_MAX_ACTIVE_PER_SCOPE = 200;

export type KnowledgeStatus = 'active' | 'pending';
export type KnowledgeProvenance = { sourceConversationId: string; ts: string };
export type KnowledgeItem = {
  id: string;
  topic: string;
  title: string;
  content: string;
  confidence: number;
  status: KnowledgeStatus;
  scope: MemoryScope;
  provenance: KnowledgeProvenance;
  updatedAt: string;
};
export type KnowledgeCandidateInput = { topic?: unknown; title?: unknown; content?: unknown; confidence?: unknown; scope?: unknown };
export type UpsertOptions = {
  sourceConversationId?: string;
  confidenceThreshold?: number;
  maxActivePerScope?: number;
  now?: Date;
};
export type UpsertResult = {
  stored: boolean;
  status?: KnowledgeStatus;
  merged?: boolean;
  reason?: string;
  evicted?: Array<{ id: string; title: string }>;
};

function knowledgeFile(trustedRoot: unknown): string {
  return path.join(memoryDir(trustedRoot), KNOWLEDGE_FILE);
}

function readAll(trustedRoot: unknown): KnowledgeItem[] {
  const raw = safeReadSync(knowledgeFile(trustedRoot), '');
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    return Array.isArray(parsed.items) ? parsed.items as KnowledgeItem[] : [];
  } catch {
    return [];
  }
}

function writeAll(trustedRoot: unknown, items: KnowledgeItem[]): void {
  safeWriteSync(knowledgeFile(trustedRoot), `${JSON.stringify({ version: 1, items }, null, 2)}\n`);
}

function normScope(value: unknown): MemoryScope {
  return value === 'user' || value === 'session' ? value : 'project';
}

function normKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** 去重键:同 scope + 主题 + 标题 视为同一条知识(改值即 supersede,不新增重复)。 */
function dedupKey(scope: MemoryScope, topic: unknown, title: unknown): string {
  return `${scope}::${normKey(topic)}::${normKey(title)}`;
}

/** 把一条候选知识 upsert 进知识库:DLP → 去重合并 → 置信度门 → 容量淘汰。 */
export function upsertKnowledgeItem(
  trustedRoot: unknown,
  candidate: KnowledgeCandidateInput,
  options: UpsertOptions = {},
): UpsertResult {
  ensureTrustedRoot(trustedRoot);
  const content = String(candidate?.content ?? '').trim();
  if (!content) return { stored: false, reason: 'empty content' };
  const title = String(candidate?.title ?? '').trim() || content.slice(0, 24);
  const topic = String(candidate?.topic ?? '').trim() || 'general';

  // DLP:含密钥/敏感凭据一律不入库。
  const dlp = decideMemoryDlp({ title, content, evidence: 'conversation_consolidation' });
  if (dlp.action === 'deny_write') return { stored: false, reason: `dlp:${dlp.sensitivity}` };

  const scope = normScope(candidate?.scope);
  const threshold = Number.isFinite(options.confidenceThreshold) ? Number(options.confidenceThreshold) : DEFAULT_CONFIDENCE_THRESHOLD;
  const maxActive = Number.isFinite(options.maxActivePerScope) ? Number(options.maxActivePerScope) : DEFAULT_MAX_ACTIVE_PER_SCOPE;
  const confidence = Math.min(1, Math.max(0, Number(candidate?.confidence) || 0));
  const status: KnowledgeStatus = confidence >= threshold ? 'active' : 'pending';
  const ts = (options.now || new Date()).toISOString();

  const items = readAll(trustedRoot);
  const key = dedupKey(scope, topic, title);
  const existingIdx = items.findIndex((it) => dedupKey(normScope(it.scope), it.topic, it.title) === key);

  let merged = false;
  if (existingIdx >= 0) {
    // 去重合并/supersede:同一条知识改值,置信度取较高者,时间更新,id 保留。
    const prev = items[existingIdx] as KnowledgeItem;
    items[existingIdx] = {
      ...prev,
      content,
      topic,
      title,
      confidence: Math.max(prev.confidence, confidence),
      status: Math.max(prev.confidence, confidence) >= threshold ? 'active' : prev.status,
      provenance: { sourceConversationId: String(options.sourceConversationId || prev.provenance?.sourceConversationId || ''), ts },
      updatedAt: ts,
    };
    merged = true;
  } else {
    items.push({
      id: memoryId('know'),
      topic, title, content, confidence, status, scope,
      provenance: { sourceConversationId: String(options.sourceConversationId || ''), ts },
      updatedAt: ts,
    });
  }

  // 容量淘汰:同 scope 的 active 超上限时,按 updatedAt 淘汰最旧的(不静默,返回被淘汰项)。
  const evicted: Array<{ id: string; title: string }> = [];
  const activeInScope = items.filter((it) => it.status === 'active' && normScope(it.scope) === scope);
  if (activeInScope.length > maxActive) {
    const sorted = [...activeInScope].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    const toEvict = sorted.slice(0, activeInScope.length - maxActive);
    for (const victim of toEvict) {
      const idx = items.findIndex((it) => it.id === victim.id);
      if (idx >= 0) { items.splice(idx, 1); evicted.push({ id: victim.id, title: victim.title }); }
    }
  }

  writeAll(trustedRoot, items);
  return omitEmptyEvicted({ stored: true, status: items.find((it) => dedupKey(normScope(it.scope), it.topic, it.title) === key)?.status || status, merged, evicted });
}

function omitEmptyEvicted(result: UpsertResult): UpsertResult {
  if (result.evicted && result.evicted.length === 0) { const { evicted, ...rest } = result; void evicted; return rest; }
  return result;
}

/** 列出知识条目,可按状态过滤。 */
export function listKnowledgeItems(trustedRoot: unknown, options: { status?: KnowledgeStatus } = {}): KnowledgeItem[] {
  const items = readAll(trustedRoot);
  return options.status ? items.filter((it) => it.status === options.status) : items;
}

/** 设置某条知识的状态(批准 pending→active 或退回 active→pending);找不到返回 false。 */
export function setKnowledgeItemStatus(trustedRoot: unknown, id: string, status: KnowledgeStatus): boolean {
  const items = readAll(trustedRoot);
  const idx = items.findIndex((it) => it.id === id);
  if (idx < 0) return false;
  const prev = items[idx] as KnowledgeItem;
  items[idx] = { ...prev, status, updatedAt: new Date().toISOString() };
  writeAll(trustedRoot, items);
  return true;
}
