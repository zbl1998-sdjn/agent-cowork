// 对话数据清洗工具(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:对外部传入的对话字段做安全归一与裁剪——校验 id 合法性、限制消息/分支数量、
//       补默认标题与分支 id,避免单文档膨胀或脏数据落库。
// 依赖:L1 storage(conversation-types 的类型契约)。
// 导出:MAX_CONVERSATION_TITLE, cleanConversationId, sanitizeConversationMessages,
//       safeOptionalConversationId, sanitizeConversationBranches。
import type { ConversationBranch } from './conversation-types.js';

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_CONVERSATION_TITLE = 200;

/** 校验对话 id 合法性,非法抛错。 */
export function cleanConversationId(id: unknown): string {
  const text = String(id || '').trim();
  if (!ID_RE.test(text)) throw new Error('invalid conversation id');
  return text;
}

/** 仅保留最近 200 条消息,防止单文档膨胀。 */
export function sanitizeConversationMessages(messages: unknown): unknown[] {
  return Array.isArray(messages) ? messages.slice(-200) : [];
}

/** 校验可选 id(分支/baseMessage),非法返回空串而非抛错。 */
export function safeOptionalConversationId(value: unknown): string {
  const text = String(value || '').trim();
  return ID_RE.test(text) ? text : '';
}

/** 清洗分支列表:限 12 条,补默认 id/标题,逐分支裁剪消息。 */
export function sanitizeConversationBranches(branches: unknown): ConversationBranch[] {
  if (!Array.isArray(branches)) return [];
  return branches.slice(-12).map((branch, index) => {
    const source = (branch || {}) as Record<string, unknown>;
    const id = safeOptionalConversationId(source.id) || (index === 0 ? 'main' : `branch-${index}`);
    return {
      id,
      title: String(source.title || (index === 0 ? '主线' : `分支 ${index}`)).slice(0, MAX_CONVERSATION_TITLE),
      ...(safeOptionalConversationId(source.parentBranchId) ? { parentBranchId: String(source.parentBranchId) } : {}),
      ...(source.baseMessageId ? { baseMessageId: String(source.baseMessageId).slice(0, 96) } : {}),
      ...(source.createdAt ? { createdAt: String(source.createdAt).slice(0, 64) } : {}),
      messages: sanitizeConversationMessages(source.messages),
    };
  });
}
