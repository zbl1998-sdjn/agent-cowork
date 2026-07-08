// 对话结束提炼编排(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:把一段结束的对话缓冲提炼成主题知识条目——载缓冲 → 渲染转录 → gated LLM 提取
//       (callJson 由调用方注入,复用 recipes/model-recipe-extract 的 callModelForJson,
//        经 decideEgressPolicy 出站闸门,机密档下同样拒绝出网)→ 归一 → 逐条 upsert 进
//       knowledge-store(DLP/去重合并/置信度门/容量淘汰)→ 清理缓冲。任一步失败 fail-safe。
// 依赖:同层 conversation-buffer / knowledge-extractor / knowledge-store。callJson 注入,
//       故可脱离真实模型单测。导出:consolidateConversation。
import { clearConversationBuffer, readRecentTurns } from './conversation-buffer.js';
import { buildKnowledgeExtractionPrompt, formatConversationForExtraction, normalizeKnowledgeItems } from './knowledge-extractor.js';
import { upsertKnowledgeItem } from './knowledge-store.js';

const DEFAULT_MIN_TURNS = 4;

export type ConsolidateCallJson = (args: { system: string; user: string; modelConfig: unknown; trustedRoot: unknown }) => Promise<unknown>;
export type ConsolidateOptions = {
  trustedRoot: unknown;
  conversationId: unknown;
  modelConfig: unknown;
  callJson: ConsolidateCallJson;
  minTurns?: number;
  confidenceThreshold?: number;
  maxActivePerScope?: number;
};
export type ConsolidateResult = {
  consolidated: boolean;
  stored?: number;
  active?: number;
  pending?: number;
  reason?: string;
};

/** 提炼一段结束的对话为主题知识:太短则跳过;提取失败保留缓冲以便重试;成功(含空提取)清理缓冲。 */
export async function consolidateConversation(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const { trustedRoot, conversationId, modelConfig, callJson } = options;
  const minTurns = Number.isFinite(options.minTurns) ? Number(options.minTurns) : DEFAULT_MIN_TURNS;

  const turns = readRecentTurns(trustedRoot, conversationId, { maxTurns: 200 });
  if (turns.length < Math.max(1, minTurns)) {
    return { consolidated: false, reason: 'too short' };
  }

  const conversationText = formatConversationForExtraction(turns);
  const { system, user } = buildKnowledgeExtractionPrompt(conversationText);

  let parsed: unknown;
  try {
    parsed = await callJson({ system, user, modelConfig, trustedRoot });
  } catch (err) {
    // 提取失败(模型不可达/出站被拒等):保留缓冲,下次可重试,不抛。
    return { consolidated: false, reason: `extract failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const candidates = normalizeKnowledgeItems(parsed);
  let active = 0;
  let pending = 0;
  for (const candidate of candidates) {
    const res = upsertKnowledgeItem(trustedRoot, candidate, {
      sourceConversationId: String(conversationId ?? ''),
      ...(Number.isFinite(options.confidenceThreshold) ? { confidenceThreshold: Number(options.confidenceThreshold) } : {}),
      ...(Number.isFinite(options.maxActivePerScope) ? { maxActivePerScope: Number(options.maxActivePerScope) } : {}),
    });
    if (!res.stored) continue;
    if (res.status === 'active') active += 1;
    else if (res.status === 'pending') pending += 1;
  }

  // 成功一轮提取(即便没有可存条目)即视为该对话已消化,清缓冲避免重复提炼。
  clearConversationBuffer(trustedRoot, conversationId);
  return { consolidated: true, stored: active + pending, active, pending };
}
