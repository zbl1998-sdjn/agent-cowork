import { sendJson, withJsonBody } from '../http/request-utils.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';

/** @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest */
/** @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse */
/** @typedef {{ trustedRootDefault?: string, safeTrustedRoot(input?: unknown): string }} SearchState */

/** @param {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext?: Record<string, unknown>, state: SearchState }} options */
export async function handleSearchRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method !== 'POST' || pathname !== '/api/workspace/search') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const input = /** @type {{ trustedRoot?: unknown, query?: unknown, limit?: unknown, maxFiles?: unknown, maxFileBytes?: unknown, maxChunkLines?: number, maxChunkBytes?: number }} */ (body || {});
    const trustedRoot = state.safeTrustedRoot(input.trustedRoot || state.trustedRootDefault);
    const result = searchWorkspaceIndex({
      root: trustedRoot,
      query: input.query,
      limit: input.limit,
      maxFiles: input.maxFiles,
      maxFileBytes: input.maxFileBytes,
      maxChunkLines: input.maxChunkLines,
      maxChunkBytes: input.maxChunkBytes,
    });
    sendJson(response, 200, {
      ...result,
      context: requestContext,
    });
  });
  return true;
}
