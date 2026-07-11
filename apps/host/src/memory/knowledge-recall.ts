// 主题知识召回(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:新对话开始时按当前 prompt 的相关性,从知识库挑出最相关的若干条 active 主题知识,
//       供 agent-stream 读缝注入系统提示——让新对话「想起之前说过的」。相关性门控:不相关
//       就不注入(读侧防污染);pending 条目永不召回。相关性用轻量关键词/2-gram 重叠打分
//       (零依赖、CJK 友好),接口预留可后续替换为嵌入检索。
// 依赖:同层 knowledge-store。导出:recallRelevantKnowledge / formatKnowledgeForInjection。
import { listKnowledgeItems, type KnowledgeItem } from './knowledge-store.js';
import type { MemoryOwnerContext } from './memory-owner.js';

const DEFAULT_LIMIT = 6;

/** 从 query 里抽取匹配用 token:英文/数字词(len>=2) + CJK 连续段的 2-gram。 */
function queryTokens(query: string): string[] {
  const text = String(query || '').toLowerCase();
  const tokens = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2 && /[a-z0-9]/.test(word)) tokens.add(word);
  }
  for (const run of text.match(/[㐀-鿿]+/g) || []) {
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i += 1) tokens.add(run.slice(i, i + 2));
    } else {
      tokens.add(run);
    }
  }
  return [...tokens];
}

function scoreItem(item: KnowledgeItem, tokens: string[]): number {
  const hay = `${item.topic} ${item.title} ${item.content}`.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) score += 1;
  }
  return score;
}

/** 按相关性挑最相关的 active 知识 top-K。query 为空则回落最近更新的 K 条;有 query 但都不相关则返回 []。 */
export function recallRelevantKnowledge(
  trustedRoot: unknown,
  query: string,
  options: { limit?: number; context?: MemoryOwnerContext } = {},
): KnowledgeItem[] {
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  const active = listKnowledgeItems(trustedRoot, { status: 'active', context: options.context || {} });
  if (!active.length) return [];
  const tokens = queryTokens(query);
  if (!tokens.length) {
    return [...active].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
  }
  return active
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(b.item.updatedAt).localeCompare(String(a.item.updatedAt)))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** 把召回的知识渲染成一段带标签的注入块;空则返回空串。 */
export function formatKnowledgeForInjection(items: KnowledgeItem[]): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = items
    .filter((it) => it && typeof it.content === 'string' && it.content.trim())
    .map((it) => `- [${it.topic}] ${it.title}:${it.content.trim()}`);
  return lines.length ? `与本次对话相关的长期记忆(过往对话提炼,供参考):\n${lines.join('\n')}` : '';
}
