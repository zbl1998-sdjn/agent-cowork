import { sendJson, withJsonBody, headerValue } from '../http/request-utils.js';

// Local auth routes.
//   POST /api/auth/register { username, password } -> { userId, token }
//   POST /api/auth/login    { username, password } -> { userId, token }
//   GET  /api/auth/me       (Bearer token)         -> { userId, tenantId } or 401
//   POST /api/auth/logout   (Bearer token)         -> { ok }

function bearer(request) {
  const value = headerValue(request, 'authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export async function handleAuthRoutes({ request, response, pathname, requestContext, authStore }) {
  if (!authStore) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/auth/register') {
    await withJsonBody(request, response, async (body) => {
      try {
        const identity = authStore.register(body && body.username, body && body.password);
        const token = authStore.createSession(identity);
        sendJson(response, 200, { ...identity, token });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/guest') {
    // Local "skip login": mint an isolated guest identity + token so the gate
    // still applies (no anonymous unauthenticated access to the API).
    try {
      sendJson(response, 200, authStore.createGuest());
    } catch (err) {
      sendJson(response, err.statusCode || 500, { error: err.message });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    await withJsonBody(request, response, async (body) => {
      try {
        sendJson(response, 200, authStore.login(body && body.username, body && body.password));
      } catch (err) {
        sendJson(response, err.statusCode || 401, { error: err.message });
      }
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const session = authStore.resolveToken(bearer(request));
    if (!session) {
      sendJson(response, 401, { error: 'not authenticated' });
      return true;
    }
    sendJson(response, 200, { userId: session.userId, tenantId: session.tenantId, username: session.username, context: requestContext });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    sendJson(response, 200, { ok: authStore.logout(bearer(request)) });
    return true;
  }

  return false;
}
