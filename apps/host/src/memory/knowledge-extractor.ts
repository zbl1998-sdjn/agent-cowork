// 主题知识提炼器(host · L1 领域层 · memory)· 纯函数
// ---------------------------------------------------------------------------
// 职责:为「对话结束提炼主题知识」提供纯逻辑——构造保守的 JSON-only 提取 prompt、把对话渲染
//       成带角色标签的转录、并把模型返回的已解析 JSON 归一/校验成 {topic,title,content,
//       confidence} 候选(容忍中英字段别名、夹取置信度、去空、限量)。不做模型调用、不落盘,
//       故可脱离模型确定性单测;真正的 gated 模型调用与写库在 consolidate 编排层。
// 依赖:仅同层 conversation-buffer 的类型。导出:normalizeKnowledgeItems /
//       buildKnowledgeExtractionPrompt / formatConversationForExtraction。
import type { ConversationTurn } from './conversation-buffer.js';

export type KnowledgeCandidate = { topic: string; title: string; content: string; confidence: number };

const MAX_ITEMS = 20;

function cleanStr(value: unknown, fallback = ''): string {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/** 夹取置信度到 [0,1];缺失/非数字回落 0.5(中性)。 */
function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** 把模型返回的已解析 JSON 归一为知识候选:容忍数组或 {items:[...]} 包裹、中英字段别名;只保留有 content 的条目;限量。 */
export function normalizeKnowledgeItems(parsed: unknown): KnowledgeCandidate[] {
  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : []);
  const out: KnowledgeCandidate[] = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const content = cleanStr(r.content ?? r.内容 ?? r.value ?? r.值 ?? r.fact ?? r.事实);
    if (!content) continue;
    out.push({
      topic: cleanStr(r.topic ?? r.主题 ?? r.category ?? r.类别 ?? r.类型, 'general'),
      title: cleanStr(r.title ?? r.标题 ?? r.key ?? r.键 ?? r.name, content.slice(0, 24)),
      content,
      confidence: clampConfidence(r.confidence ?? r.置信度 ?? r.score ?? r.分数),
    });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

const ROLE_LABELS: Record<string, string> = { user: '用户', assistant: '助手' };

/** 把对话缓冲渲染成带角色标签的转录,供提取 prompt 使用。 */
export function formatConversationForExtraction(turns: ConversationTurn[]): string {
  if (!Array.isArray(turns)) return '';
  return turns
    .filter((t) => t && typeof t.text === 'string' && t.text.trim())
    .map((t) => `${ROLE_LABELS[t.role] || t.role}: ${t.text.trim()}`)
    .join('\n');
}

const KNOWLEDGE_SYSTEM = '你是严谨的长期记忆提炼助手。只输出 JSON 数组,不要任何解释或 markdown 代码块。';

/** 构造保守的主题知识提取 prompt:只提炼耐用知识、跳过闲聊/一次性任务/纯问答、不编造、不含密钥。 */
export function buildKnowledgeExtractionPrompt(conversationText: string): { system: string; user: string } {
  const user =
    '从下面这段对话里提炼出「跨对话仍值得长期记住」的耐用主题知识,输出 JSON 数组,每项形如 ' +
    '{"topic":"主题(如 项目/偏好/身份/决定)","title":"简短标题","content":"一句话知识","confidence":0到1的置信度}。\n' +
    '严格要求:只提炼耐用、可复用的知识(用户身份/偏好/项目事实/决定等);' +
    '跳过闲聊、一次性任务指令、纯问答、临时上下文;不要编造对话里没有的内容;' +
    '不要包含任何密钥/令牌/密码等机密或敏感凭据;没有值得长期记住的就返回空数组 []。\n\n' +
    `对话:\n${String(conversationText || '').slice(0, 8000)}`;
  return { system: KNOWLEDGE_SYSTEM, user };
}
