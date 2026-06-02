// 连接器 OAuth 状态响应(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:封装 OAuth 状态查询响应,让 connector-oauth-routes 聚焦路由分支与授权流程。
import { sendJson } from '../http/request-utils.js';
import {
  GITHUB_CLIENT_ID_ENV_KEYS,
  githubClientId,
  githubConnector,
  isGitHub,
  oauthFilter,
} from './connector-oauth-route-utils.js';
import { oauthPermissions } from '../connectors/oauth-permissions.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import type { CredentialStore } from '../security/credential-store.js';
import type { RequestContext } from './connector-oauth-route-utils.js';

export function unsupportedOAuthConnector(response: HttpResponseLike): void {
  sendJson(response, 400, { error: 'unsupported OAuth connector' });
}

export function sendConnectorOAuthStatus({
  response,
  requestUrl,
  requestContext,
  credentialStore,
  oauthConfig,
}: {
  response: HttpResponseLike;
  requestUrl: URL;
  requestContext: RequestContext;
  credentialStore?: CredentialStore;
  oauthConfig?: unknown;
}): void {
  const id = requestUrl.searchParams.get('id') || requestUrl.searchParams.get('provider') || '';
  if (!isGitHub(id) || !credentialStore) {
    unsupportedOAuthConnector(response);
    return;
  }
  const accounts = credentialStore.list(oauthFilter(requestContext, 'github'));
  sendJson(response, 200, {
    context: requestContext,
    provider: 'github',
    connected: accounts.length > 0,
    accounts,
    configured: Boolean(githubClientId(oauthConfig)),
    requiredEnv: GITHUB_CLIENT_ID_ENV_KEYS,
    configurationMessage: githubClientId(oauthConfig)
      ? 'GitHub OAuth client id 已配置。'
      : 'GitHub OAuth 需要先配置 KCW_GITHUB_OAUTH_CLIENT_ID。',
    permissions: oauthPermissions(githubConnector()),
  });
}
