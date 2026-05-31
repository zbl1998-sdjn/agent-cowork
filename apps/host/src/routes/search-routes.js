// 搜索路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/search/* —— 在可信工作区内做文件名/内容或 RAG 检索,返回命中与摘录。
// 依赖:L0 request-utils + L1 workspace 检索(经 state 注入)。导出:handleSearchRoutes。
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
