import { sendJson, withJsonBody } from '../http/request-utils.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';

export async function handleSearchRoutes({ request, response, pathname, requestContext, state }) {
  if (request.method !== 'POST' || pathname !== '/api/workspace/search') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const trustedRoot = state.safeTrustedRoot(body?.trustedRoot || state.trustedRootDefault);
    const result = searchWorkspaceIndex({
      root: trustedRoot,
      query: body?.query,
      limit: body?.limit,
      maxFiles: body?.maxFiles,
      maxFileBytes: body?.maxFileBytes,
      maxChunkLines: body?.maxChunkLines,
      maxChunkBytes: body?.maxChunkBytes,
    });
    sendJson(response, 200, {
      ...result,
      context: requestContext,
    });
  });
  return true;
}
