import crypto from 'node:crypto';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import {
  completeGitHubDeviceFlow,
  fetchGitHubViewer,
  startGitHubDeviceFlow,
} from '../connectors/oauth-github.js';

function isGitHub(id) {
  return String(id || '').toLowerCase() === 'github';
}

function githubClientId(body, oauthConfig) {
  return String(
    (body && body.clientId)
      || oauthConfig?.github?.clientId
      || process.env.KCW_GITHUB_OAUTH_CLIENT_ID
      || process.env.GITHUB_OAUTH_CLIENT_ID
      || '',
  ).trim();
}

function oauthIdentity(requestContext, provider, accountId = 'default') {
  return {
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    provider,
    accountId,
  };
}

function oauthFilter(requestContext, provider) {
  return {
    tenantId: requestContext.tenantId,
    userId: requestContext.userId,
    provider,
  };
}

export async function handleConnectorOAuthRoutes({
  request, response, pathname, requestUrl, requestContext,
  credentialStore, oauthSessions, oauthFetch, oauthConfig,
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
      configured: Boolean(githubClientId({}, oauthConfig)),
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/start') {
    await withJsonBody(request, response, async (body) => {
      if (!isGitHub(body && body.id)) {
        sendJson(response, 400, { error: 'unsupported OAuth connector' });
        return;
      }
      if (body && body.clientSecret) {
        sendJson(response, 400, { error: 'client_secret is not accepted by the device-flow connector' });
        return;
      }
      try {
        const clientId = githubClientId(body, oauthConfig);
        const started = await startGitHubDeviceFlow({
          clientId,
          scopes: body && body.scopes,
          fetchImpl: oauthFetch,
        });
        const sessionId = crypto.randomUUID();
        const expiresAtMs = Date.now() + Math.max(1, started.expiresIn) * 1000;
        oauthSessions.set(sessionId, {
          provider: 'github',
          clientId,
          deviceCode: started.deviceCode,
          scopes: started.scopes,
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
        sendJson(response, err.statusCode || 502, { error: err.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/complete') {
    await withJsonBody(request, response, async (body) => {
      const sessionId = String((body && body.sessionId) || '');
      const session = oauthSessions && oauthSessions.get(sessionId);
      if (!isGitHub(body && body.id) || !session || session.provider !== 'github') {
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
        });
      } catch (err) {
        sendJson(response, err.statusCode || 502, { error: err.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/oauth/revoke') {
    await withJsonBody(request, response, async (body) => {
      if (!isGitHub(body && body.id) || !credentialStore) {
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
