import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';

// Per-user conversation history.
//   GET    /api/conversations            -> { conversations: [summary...] }
//   GET    /api/conversations?full=1     -> { conversations: [full doc...] }
//   GET    /api/conversations/:id        -> { conversation } | 404
//   PUT    /api/conversations/:id        -> { conversation: summary } (upsert)
//   DELETE /api/conversations/:id        -> { deleted: bool }
// All operations are scoped to requestContext.tenantId/userId by the store, so
// one signed-in user can never read or write another's history.
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

  const resolveRoot = (raw) => assertTrustedPath(path.resolve(raw || trustedRootDefault), trustedRootDefault);
  const resolveRootOrSend = (raw) => {
    try {
      return resolveRoot(raw);
    } catch (err) {
      sendJson(response, err.statusCode || 400, { error: err.message });
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
        sendJson(response, 400, { error: err.message });
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
        const safeRoot = resolveRoot(body && body.trustedRoot);
        try {
          const summary = await conversationStore.save(
            safeRoot,
            {
              id,
              title: body && body.title,
              pinned: body && body.pinned,
              messages: body && body.messages,
              activeBranchId: body && body.activeBranchId,
              branches: body && body.branches,
            },
            requestContext,
          );
          sendJson(response, 200, { conversation: summary });
        } catch (err) {
          sendJson(response, 400, { error: err.message });
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
        sendJson(response, 400, { error: err.message });
        return true;
      }
      sendJson(response, 200, { deleted });
      return true;
    }
  }

  return false;
}
