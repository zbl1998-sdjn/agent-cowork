// 对话结束的惰性提炼触发(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:惰性检测「用户切到了另一个对话」——按 <root::tenant::user> 记住上一个活跃 conversationId,
//       当新一轮的 conversationId 与之不同,就把上一个对话提炼成主题知识(consolidateConversation)。
//       生产在 agent-stream 读缝调用且不 await(fire-and-forget、错误吞掉,不加聊天延迟);
//       返回 { triggeredConversationId, done } 让测试可 await done 做确定性断言。
// 依赖:同层 consolidate。导出:maybeConsolidatePreviousConversation / __resetConsolidateTriggerState。
import { consolidateConversation, type ConsolidateCallJson } from './consolidate.js';

// 模块级「上一个活跃对话」表:key = root::tenant::user。宿主为长驻进程,重启后表清空,
// 遗留缓冲留待显式端点/后台清扫兜底(Phase 3),不会丢数据。
const lastActiveConversation = new Map<string, string>();

export type MaybeConsolidateOptions = {
  trustedRoot: unknown;
  tenantId?: unknown;
  userId?: unknown;
  conversationId: unknown;
  modelConfig: unknown;
  callJson: ConsolidateCallJson;
  minTurns?: number;
};
export type MaybeConsolidateResult = { triggeredConversationId: string | null; done: Promise<void> };

function keyOf(trustedRoot: unknown, tenantId: unknown, userId: unknown): string {
  return `${String(trustedRoot ?? '')}::${String(tenantId ?? '')}::${String(userId ?? '')}`;
}

/** 惰性触发:conversationId 变化时提炼上一个对话。生产不 await 返回的 done;测试可 await。 */
export function maybeConsolidatePreviousConversation(options: MaybeConsolidateOptions): MaybeConsolidateResult {
  const conversationId = String(options.conversationId ?? '').trim();
  const key = keyOf(options.trustedRoot, options.tenantId, options.userId);
  const prev = lastActiveConversation.get(key);
  lastActiveConversation.set(key, conversationId);

  if (!prev || prev === conversationId) {
    return { triggeredConversationId: null, done: Promise.resolve() };
  }
  const done = consolidateConversation({
    trustedRoot: options.trustedRoot,
    conversationId: prev,
    modelConfig: options.modelConfig,
    callJson: options.callJson,
    ...(Number.isFinite(options.minTurns) ? { minTurns: Number(options.minTurns) } : {}),
  }).then(() => undefined).catch(() => undefined);
  return { triggeredConversationId: prev, done };
}

/** 测试用:清空模块级 last-active 表,隔离用例。 */
export function __resetConsolidateTriggerState(): void {
  lastActiveConversation.clear();
}
