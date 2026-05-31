// 连接器 OAuth 路由·工具(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:connector-oauth-routes 用到的纯工具——识别 GitHub、取客户端 id、由请求上下文构造凭据身份/过滤器、
//       归一化错误状态码与消息。便于单测、保持路由处理精简。依赖:L1 connectors/catalog。
import { getConnector } from '../connectors/catalog.js';

export const GITHUB_CLIENT_ID_ENV_KEYS = Object.freeze(['KCW_GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_ID']);

/**
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ tenantId?: string, userId?: string, [key: string]: unknown }} RequestContext
 */

/** @param {unknown} id */
export function isGitHub(id) {
  return String(id || '').toLowerCase() === 'github';
}

/** @param {{ github?: { clientId?: unknown } }} [oauthConfig] */
export function githubClientId(oauthConfig) {
  return String(
    oauthConfig?.github?.clientId
      || process.env.KCW_GITHUB_OAUTH_CLIENT_ID
      || process.env.GITHUB_OAUTH_CLIENT_ID
      || '',
  ).trim();
}

/** @param {RequestContext} requestContext @param {string} provider @param {string} [accountId] */
export function oauthIdentity(requestContext, provider, accountId = 'default') {
  return {
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    provider,
    accountId,
  };
}

/** @param {RequestContext} requestContext @param {string} provider */
export function oauthFilter(requestContext, provider) {
  return {
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    provider,
  };
}

export function githubConnector() {
  const connector = getConnector('github');
  if (!connector) {
    const err = /** @type {RouteError} */ (new Error('GitHub connector is not registered'));
    err.statusCode = 500;
    throw err;
  }
  return connector;
}

/** @param {unknown} err @param {number} fallback */
export function errorStatus(err, fallback) {
  return err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
    ? err.statusCode
    : fallback;
}

/** @param {unknown} err */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
