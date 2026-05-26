import crypto from 'node:crypto';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { completeGitHubDeviceFlow, fetchGitHubViewer, startGitHubDeviceFlow } from '../connectors/oauth-github.js';
import { normalizeOAuthScopes, oauthPermissions, selectedOAuthPermissions } from '../connectors/oauth-permissions.js';
import { errorMessage, errorStatus, GITHUB_CLIENT_ID_ENV_KEYS, githubClientId, githubConnector, isGitHub, oauthFilter, oauthIdentity } from './connector-oauth-route-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('./connector-oauth-route-utils.js').RequestContext} RequestContext
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, credentialStore?: any, oauthPermissionApprovals?: any, oauthSessions: Map<string, any>, oauthFetch?: typeof globalThis.fetch, oauthConfig?: { github?: { clientId?: unknown } } }} ConnectorOAuthRouteOptions
 * @typedef {{ id?: unknown, scopes?: unknown, approvalId?: unknown, oauthApprovalId?: unknown, clientSecret?: unknown, sessionId?: unknown }} ConnectorOAuthBody
 */

/** @param {ConnectorOAuthRouteOptions} options */
export async function handleConnectorOAuthRoutes({
  request, response, pathname, requestUrl, requestContext,
  credentialStore, oauthPermissionApprovals, oauthSessions, oauthFetch, oauthConfig,
}) {
  if (request.method === 'GET' && pathname === '/api/connectors/oauth/status') {
    const id = requestUrl.searchParams.get('id') || requestUrl.searchParams.get('provider') || '';
    if (!isGitHub(id) || !credentialStore) {
      sendJson(response, 400, { error: 'unsupported OAuth connector' });
      return true;
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
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/approve') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ConnectorOAuthBody} */ (body || {});
      if (!isGitHub(input.id) || !oauthPermissionApprovals) {
        sendJson(response, 400, { error: 'unsupported OAuth connector' });
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
      const input = /** @type {ConnectorOAuthBody} */ (body || {});
      if (!isGitHub(input.id)) {
        sendJson(response, 400, { error: 'unsupported OAuth connector' });
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
        const started = await startGitHubDeviceFlow({
          clientId,
          scopes,
          fetchImpl: oauthFetch,
        });
        const sessionId = crypto.randomUUID();
        const expiresAtMs = Date.now() + Math.max(1, started.expiresIn) * 1000;
        oauthSessions.set(sessionId, {
          provider: 'github',
          clientId,
          deviceCode: started.deviceCode,
          scopes: started.scopes,
          permissions: selectedOAuthPermissions(connector, started.scopes),
          tenantId: requestContext.tenantId,
          userId: requestContext.userId,
          expiresAtMs,
        });
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
      const input = /** @type {ConnectorOAuthBody} */ (body || {});
      const sessionId = String(input.sessionId || '');
      const session = oauthSessions && oauthSessions.get(sessionId);
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
      try {
        const completed = await completeGitHubDeviceFlow({
          clientId: session.clientId,
          deviceCode: session.deviceCode,
          fetchImpl: oauthFetch,
        });
        if (completed.status === 'pending') {
          sendJson(response, 202, {
            context: requestContext,
            provider: 'github',
            status: 'pending',
            interval: completed.interval,
          });
          return;
        }
        const account = await fetchGitHubViewer({ accessToken: completed.accessToken, fetchImpl: oauthFetch });
        const summary = credentialStore.put(oauthIdentity(requestContext, 'github', account.login), {
          accessToken: completed.accessToken,
          tokenType: completed.tokenType,
          scope: completed.scope || session.scopes.join(' '),
          account,
          obtainedAt: new Date().toISOString(),
        });
        oauthSessions.delete(sessionId);
        sendJson(response, 200, {
          context: requestContext,
          provider: 'github',
          connected: true,
          account,
          credential: summary,
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
      const input = /** @type {ConnectorOAuthBody} */ (body || {});
      if (!isGitHub(input.id) || !credentialStore) {
        sendJson(response, 400, { error: 'unsupported OAuth connector' });
        return;
      }
      const removed = credentialStore.deleteMany(oauthFilter(requestContext, 'github'));
      sendJson(response, 200, { context: requestContext, provider: 'github', removed });
    });
    return true;
  }

  return false;
}
