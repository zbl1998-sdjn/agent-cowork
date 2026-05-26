import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ tenantId?: string, userId?: string, traceId?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ trustedRoot?: unknown, title?: unknown, pinned?: unknown, messages?: unknown, activeBranchId?: unknown, branches?: unknown }} ConversationBody
 * @typedef {{ id: string, title?: string, pinned?: boolean, messages?: unknown, activeBranchId?: unknown, branches?: unknown }} ConversationInput
 * @typedef {{ list(root: string, context: RequestContext): unknown[] | Promise<unknown[]>, get(root: string, id: string, context: RequestContext): unknown | Promise<unknown>, save(root: string, conversation: ConversationInput, context: RequestContext): unknown | Promise<unknown>, remove(root: string, id: string, context: RequestContext): boolean | Promise<boolean>, listFull?: (root: string, context: RequestContext, options?: { limit?: number }) => unknown[] | Promise<unknown[]>, query?: (root: string, context: RequestContext, options?: { q?: string, limit?: number, offset?: number }) => { items: unknown[], total: number } | Promise<{ items: unknown[], total: number }> }} ConversationStoreLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, trustedRootDefault: string, conversationStore?: ConversationStoreLike | null }} ConversationRouteOptions
 */

// Per-user conversation history.
//   GET    /api/conversations            -> { conversations: [summary...] }
//   GET    /api/conversations?full=1     -> { conversations: [full doc...] }
//   GET    /api/conversations/:id        -> { conversation } | 404
//   PUT    /api/conversations/:id        -> { conversation: summary } (upsert)
//   DELETE /api/conversations/:id        -> { deleted: bool }
// All operations are scoped to requestContext.tenantId/userId by the store, so
// one signed-in user can never read or write another's history.
/** @param {ConversationRouteOptions} options @returns {Promise<boolean>} */
export async function handleConversationRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  trustedRootDefault,
  conversationStore,
}) {
  if (!conversationStore || !pathname.startsWith('/api/conversations')) {
    return false;
  }

  /** @param {unknown} raw @returns {string} */
  const resolveRoot = (raw) => {
    if (raw != null && raw !== '' && typeof raw !== 'string') {
      throw new Error('trustedRoot must be a string');
    }
    return assertTrustedPath(path.resolve(raw || trustedRootDefault), trustedRootDefault);
  };
  /** @param {unknown} raw @returns {string | null} */
  const resolveRootOrSend = (raw) => {
    try {
      return resolveRoot(raw);
    } catch (err) {
      const error = /** @type {RouteError} */ (err);
      sendJson(response, error.statusCode || 400, { error: error.message });
      return null;
    }
  };

  if (request.method === 'GET' && pathname === '/api/conversations') {
    const safeRoot = resolveRootOrSend(requestUrl.searchParams.get('trustedRoot'));
    if (!safeRoot) return true;
    const params = requestUrl.searchParams;
    const full = params.get('full') === '1';
    const limitRaw = params.get('limit');
    const limit = limitRaw != null ? Math.min(Math.max(parseInt(limitRaw, 10) || 0, 1), 200) : undefined;

    if (full && typeof conversationStore.listFull === 'function') {
      const conversations = await conversationStore.listFull(safeRoot, requestContext, { limit });
      sendJson(response, 200, { conversations, context: requestContext });
      return true;
    }
    // Paginated + searched summaries.
    if (typeof conversationStore.query === 'function') {
      const offset = Math.max(parseInt(params.get('offset') || '0', 10) || 0, 0);
      const { items, total } = await conversationStore.query(safeRoot, requestContext, {
        q: params.get('q') || '',
        limit: limit || 30,
        offset,
      });
      sendJson(response, 200, { conversations: items, total, limit: limit || 30, offset, context: requestContext });
      return true;
    }
    const conversations = await conversationStore.list(safeRoot, requestContext);
    sendJson(response, 200, { conversations, context: requestContext });
    return true;
  }

  if (pathname.startsWith('/api/conversations/')) {
    const id = decodePathSegment(pathname.slice('/api/conversations/'.length));
    if (!id) {
      sendJson(response, 400, { error: 'invalid conversation id' });
      return true;
    }

    if (request.method === 'GET') {
      const safeRoot = resolveRootOrSend(requestUrl.searchParams.get('trustedRoot'));
      if (!safeRoot) return true;
      let conversation = null;
      try {
        conversation = await conversationStore.get(safeRoot, id, requestContext);
      } catch (err) {
        const error = /** @type {Error} */ (err);
        sendJson(response, 400, { error: error.message });
        return true;
      }
      if (!conversation) {
        sendJson(response, 404, { error: 'conversation not found' });
        return true;
      }
      sendJson(response, 200, { conversation });
      return true;
    }

    if (request.method === 'PUT') {
      await withJsonBody(request, response, async (body) => {
        const input = /** @type {ConversationBody} */ (body || {});
        const safeRoot = resolveRoot(input.trustedRoot);
        try {
          const summary = await conversationStore.save(
            safeRoot,
            {
              id,
              title: typeof input.title === 'string' ? input.title : undefined,
              pinned: typeof input.pinned === 'boolean' ? input.pinned : undefined,
              messages: input.messages,
              activeBranchId: input.activeBranchId,
              branches: input.branches,
            },
            requestContext,
          );
          sendJson(response, 200, { conversation: summary });
        } catch (err) {
          const error = /** @type {Error} */ (err);
          sendJson(response, 400, { error: error.message });
        }
      });
      return true;
    }

    if (request.method === 'DELETE') {
      const safeRoot = resolveRootOrSend(requestUrl.searchParams.get('trustedRoot'));
      if (!safeRoot) return true;
      let deleted = false;
      try {
        deleted = await conversationStore.remove(safeRoot, id, requestContext);
      } catch (err) {
        const error = /** @type {Error} */ (err);
        sendJson(response, 400, { error: error.message });
        return true;
      }
      sendJson(response, 200, { deleted });
      return true;
    }
  }

  return false;
}
