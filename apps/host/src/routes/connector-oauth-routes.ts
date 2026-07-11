// 连接器 OAuth 路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/connectors/*/oauth/* —— 发起 OAuth(如 GitHub 设备码)、轮询换 token、保存加密凭据、撤销授权。
//       授权范围先经 L2 oauth-permission-approvals 审批。依赖:同层 route schemas/utils + L1 connectors/security。
// 导出:handleConnectorOAuthRoutes。
import crypto from 'node:crypto';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import {
  completeGitHubDeviceFlow,
  fetchGitHubViewer,
  githubViewerDto,
  startGitHubDeviceFlow,
} from '../connectors/oauth-github.js';
import { omitUndefined } from '../util/object.js';
import { normalizeOAuthScopes, selectedOAuthPermissions } from '../connectors/oauth-permissions.js';
import { createConnectorOAuthSession } from './connector-oauth-session.js';
import {
  errorMessage,
  errorStatus,
  GITHUB_CLIENT_ID_ENV_KEYS,
  githubClientId,
  githubConnector,
  isGitHub,
  oauthFilter,
  oauthIdentity,
} from './connector-oauth-route-utils.js';
import { sendConnectorOAuthStatus, unsupportedOAuthConnector } from './connector-oauth-status.js';
import { parseConnectorOAuthBody } from './connector-oauth-route-schemas.js';
import { githubOAuthCompletionDto } from './connector-oauth-response.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { CredentialStore } from '../security/credential-store.js';
import type { OAuthPermissionApprovalStore } from '../runtime/oauth-permission-approvals.js';
import type { ConnectorOAuthSession } from './connector-oauth-session.js';
import type { RequestContext } from './connector-oauth-route-utils.js';

type RouteRequest = HttpRequestLike & { method?: string };
type GitHubOAuthConfig = { github?: { clientId?: unknown } };

export type ConnectorOAuthRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  credentialStore?: CredentialStore;
  oauthPermissionApprovals?: OAuthPermissionApprovalStore;
  oauthSessions: Map<string, ConnectorOAuthSession>;
  oauthFetch?: typeof globalThis.fetch;
  oauthConfig?: GitHubOAuthConfig;
};

export async function handleConnectorOAuthRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  credentialStore,
  oauthPermissionApprovals,
  oauthSessions,
  oauthFetch,
  oauthConfig,
}: ConnectorOAuthRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/connectors/oauth/status') {
    sendConnectorOAuthStatus(omitUndefined({ response, requestUrl, requestContext, credentialStore, oauthConfig }));
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/approve') {
    await withJsonBody(request, response, async (body) => {
      const input = parseConnectorOAuthBody(response, body);
      if (!input) return;
      if (!isGitHub(input.id) || !oauthPermissionApprovals) {
        unsupportedOAuthConnector(response);
        return;
      }
      try {
        const connector = githubConnector();
        const scopes = normalizeOAuthScopes(connector, input.scopes);
        const approval = oauthPermissionApprovals.issue({
          connectorId: 'github',
          provider: 'github',
          scopes,
          context: requestContext,
        });
        sendJson(response, 200, {
          context: requestContext,
          provider: 'github',
          approvalId: approval.id,
          expiresAt: new Date(approval.expiresAt).toISOString(),
          scopes,
          permissions: selectedOAuthPermissions(connector, scopes),
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/start') {
    await withJsonBody(request, response, async (body) => {
      const input = parseConnectorOAuthBody(response, body);
      if (!input) return;
      if (!isGitHub(input.id) || !oauthPermissionApprovals) {
        unsupportedOAuthConnector(response);
        return;
      }
      if (input.clientSecret) {
        sendJson(response, 400, { error: 'client_secret is not accepted by the device-flow connector' });
        return;
      }
      try {
        const connector = githubConnector();
        const clientId = githubClientId(oauthConfig);
        if (!clientId) {
          sendJson(response, 428, {
            context: requestContext,
            provider: 'github',
            configured: false,
            code: 'OAUTH_NOT_CONFIGURED',
            requiredEnv: GITHUB_CLIENT_ID_ENV_KEYS,
            error: 'GitHub OAuth 需要先配置 KCW_GITHUB_OAUTH_CLIENT_ID 后再开始授权。',
          });
          return;
        }
        const scopes = normalizeOAuthScopes(connector, input.scopes);
        oauthPermissionApprovals.consume(input.approvalId || input.oauthApprovalId, {
          connectorId: 'github',
          provider: 'github',
          scopes,
          context: requestContext,
        });
        const started = await startGitHubDeviceFlow(omitUndefined({
          clientId,
          scopes,
          fetchImpl: oauthFetch,
        }));
        const sessionId = crypto.randomUUID();
        const expiresAtMs = Date.now() + Math.max(1, started.expiresIn) * 1000;
        oauthSessions.set(sessionId, createConnectorOAuthSession({
          clientId,
          deviceCode: started.deviceCode,
          scopes: started.scopes,
          permissions: selectedOAuthPermissions(connector, started.scopes),
          requestContext,
          expiresAtMs,
        }));
        sendJson(response, 200, {
          context: requestContext,
          provider: 'github',
          sessionId,
          userCode: started.userCode,
          verificationUri: started.verificationUri,
          expiresAt: new Date(expiresAtMs).toISOString(),
          interval: started.interval,
          scopes: started.scopes,
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), { error: errorMessage(err) });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/complete') {
    await withJsonBody(request, response, async (body) => {
      const input = parseConnectorOAuthBody(response, body);
      if (!input) return;
      const sessionId = input.sessionId || '';
      const session = oauthSessions.get(sessionId);
      if (!isGitHub(input.id) || !session || session.provider !== 'github') {
        sendJson(response, 404, { error: 'OAuth session not found' });
        return;
      }
      if (session.tenantId !== requestContext.tenantId || session.userId !== requestContext.userId) {
        sendJson(response, 403, { error: 'OAuth session belongs to another identity' });
        return;
      }
      if (Date.now() > session.expiresAtMs) {
        oauthSessions.delete(sessionId);
        sendJson(response, 410, { error: 'OAuth session expired' });
        return;
      }
      if (!credentialStore) {
        unsupportedOAuthConnector(response);
        return;
      }
      try {
        const completed = await completeGitHubDeviceFlow(omitUndefined({
          clientId: session.clientId,
          deviceCode: session.deviceCode,
          fetchImpl: oauthFetch,
        }));
        if (completed.status === 'pending') {
          sendJson(response, 202, {
            context: requestContext,
            provider: 'github',
            status: 'pending',
            interval: completed.interval,
          });
          return;
        }
        const account = githubViewerDto(
          await fetchGitHubViewer(omitUndefined({ accessToken: completed.accessToken, fetchImpl: oauthFetch })),
        );
        const summary = credentialStore.put(oauthIdentity(requestContext, 'github', account.login), {
          accessToken: completed.accessToken,
          tokenType: completed.tokenType,
          scope: completed.scope || session.scopes.join(' '),
          account,
          obtainedAt: new Date().toISOString(),
        });
        const responseDto = githubOAuthCompletionDto(account, summary);
        oauthSessions.delete(sessionId);
        sendJson(response, 200, {
          context: requestContext,
          provider: 'github',
          connected: true,
          account: responseDto.account,
          credential: responseDto.credential,
          permissions: session.permissions || [],
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), { error: errorMessage(err) });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/revoke') {
    await withJsonBody(request, response, async (body) => {
      const input = parseConnectorOAuthBody(response, body);
      if (!input) return;
      if (!isGitHub(input.id) || !credentialStore) {
        unsupportedOAuthConnector(response);
        return;
      }
      const removed = credentialStore.deleteMany(oauthFilter(requestContext, 'github'));
      sendJson(response, 200, { context: requestContext, provider: 'github', removed });
    });
    return true;
  }

  return false;
}
