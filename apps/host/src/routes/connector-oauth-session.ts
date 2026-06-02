// 连接器 OAuth 会话(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:封装 OAuth 临时会话结构与创建逻辑,避免路由处理函数承载状态拼装细节。
import type { OAuthPermission } from '../connectors/oauth-permissions.js';
import type { RequestContext } from './connector-oauth-route-utils.js';

export type ConnectorOAuthSession = {
  provider: 'github';
  clientId: string;
  deviceCode: string;
  scopes: string[];
  permissions?: OAuthPermission[];
  tenantId?: string;
  userId?: string;
  expiresAtMs: number;
};

export function createConnectorOAuthSession({
  clientId,
  deviceCode,
  scopes,
  permissions,
  requestContext,
  expiresAtMs,
}: {
  clientId: string;
  deviceCode: string;
  scopes: string[];
  permissions: OAuthPermission[];
  requestContext: RequestContext;
  expiresAtMs: number;
}): ConnectorOAuthSession {
  const session: ConnectorOAuthSession = { provider: 'github', clientId, deviceCode, scopes, permissions, expiresAtMs };
  if (requestContext.tenantId !== undefined) session.tenantId = requestContext.tenantId;
  if (requestContext.userId !== undefined) session.userId = requestContext.userId;
  return session;
}
