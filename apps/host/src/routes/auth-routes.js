import { sendJson, withJsonBody, headerValue } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ username?: string, userId: string, tenantId: string, guest?: boolean, token?: string }} Identity
 * @typedef {{
 *   register(username: unknown, password: unknown): Identity,
 *   createSession(identity: Identity): string,
 *   createGuest(): Identity,
 *   login(username: unknown, password: unknown): Identity,
 *   resolveToken(token: string): Identity | null,
 *   logout(token: string): boolean,
 * }} AuthStoreLike
 */

// Local auth routes.
//   POST /api/auth/register { username, password } -> { userId, token }
//   POST /api/auth/login    { username, password } -> { userId, token }
//   GET  /api/auth/me       (Bearer token)         -> { userId, tenantId } or 401
//   POST /api/auth/logout   (Bearer token)         -> { ok }

/** @param {RouteRequest} request @returns {string} */
function bearer(request) {
  const value = headerValue(request, 'authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

/** @param {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext?: Record<string, unknown>, authStore?: AuthStoreLike | null }} options */
export async function handleAuthRoutes({ request, response, pathname, requestContext, authStore }) {
  if (!authStore) {
    return false;
  }

  if (request.method === 'POST' && pathname === '/api/auth/register') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = /** @type {{ username?: unknown, password?: unknown }} */ (body || {});
        const identity = authStore.register(input.username, input.password);
        const token = authStore.createSession(identity);
        sendJson(response, 200, { ...identity, token });
      } catch (err) {
        const error = /** @type {RouteError} */ (err);
        sendJson(response, error.statusCode || 400, { error: error.message });
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
      const error = /** @type {RouteError} */ (err);
      sendJson(response, error.statusCode || 500, { error: error.message });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    await withJsonBody(request, response, async (body) => {
      try {
        const input = /** @type {{ username?: unknown, password?: unknown }} */ (body || {});
        sendJson(response, 200, authStore.login(input.username, input.password));
      } catch (err) {
        const error = /** @type {RouteError} */ (err);
        sendJson(response, error.statusCode || 401, { error: error.message });
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
