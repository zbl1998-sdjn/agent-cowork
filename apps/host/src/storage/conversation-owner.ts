// 对话 owner 规范化与文件命名(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:保留 tenant/user 的精确身份值,并为文件后端生成不可碰撞、不可反解的版本化目录键。
// 依赖:标准库 crypto + conversation-types。导出:owner 值、目录键与受限 legacy 判定。
import { createHash } from 'node:crypto';
import type { ConversationContext } from './conversation-types.js';

const LOCAL_TENANT_ID = 'tenant_local';
const LOCAL_USER_ID = 'user_local';

function exactOwnerId(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

/** 返回数据库查询使用的精确 owner 值;仅真正缺失的字段使用本地默认值。 */
export function conversationOwnerValues(context: ConversationContext = {}): { tenantId: string; userId: string } {
  return {
    tenantId: exactOwnerId(context.tenantId, LOCAL_TENANT_ID),
    userId: exactOwnerId(context.userId, LOCAL_USER_ID),
  };
}

/** 文件后端只落不可碰撞的 owner tuple 哈希,避免清洗/截断造成兄弟用户串读。 */
export function conversationOwnerDirectory(context: ConversationContext = {}): string {
  const owner = conversationOwnerValues(context);
  const digest = createHash('sha256')
    .update(JSON.stringify([owner.tenantId, owner.userId]))
    .digest('hex');
  return `v1-${digest}`;
}

/** 旧明文 tenant/user 目录只对精确 local/local 身份开放,不猜测登录用户的旧映射。 */
export function legacyLocalConversationSegments(context: ConversationContext = {}): [string, string] | null {
  const owner = conversationOwnerValues(context);
  return owner.tenantId === LOCAL_TENANT_ID && owner.userId === LOCAL_USER_ID
    ? [LOCAL_TENANT_ID, LOCAL_USER_ID]
    : null;
}
