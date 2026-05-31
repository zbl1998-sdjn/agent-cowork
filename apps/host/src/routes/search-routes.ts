// 搜索路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/search/* —— 在可信工作区内做文件名/内容或 RAG 检索,返回命中与摘录。
// 依赖:L0 request-utils + L1 workspace 检索(经 state 注入)。导出:handleSearchRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { searchWorkspaceIndex } from '../workspace/index/search.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { SearchWorkspaceOptions } from '../workspace/index/search.js';

type RouteRequest = HttpRequestLike & { method?: string };
type SearchState = { trustedRootDefault?: string; safeTrustedRoot(input?: unknown): string };
type SearchRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext?: Record<string, unknown>;
  state: SearchState;
};

const optionalStringField = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
);

const optionalNumberField = z.preprocess((value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}, z.number().optional());

const workspaceSearchBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    trustedRoot: optionalStringField,
    query: z.string().trim().min(1, 'query is required').max(400, 'query too long (max 400 chars)'),
    limit: optionalNumberField,
    maxFiles: optionalNumberField,
    maxFileBytes: optionalNumberField,
    maxChunkLines: optionalNumberField,
    maxChunkBytes: optionalNumberField,
  }),
);

function parseWorkspaceSearchBody(body: unknown, state: SearchState): SearchWorkspaceOptions {
  const input = workspaceSearchBodySchema.parse(body);
  return {
    root: state.safeTrustedRoot(input.trustedRoot || state.trustedRootDefault),
    query: input.query,
    limit: input.limit,
    maxFiles: input.maxFiles,
    maxFileBytes: input.maxFileBytes,
    maxChunkLines: input.maxChunkLines,
    maxChunkBytes: input.maxChunkBytes,
  };
}

export async function handleSearchRoutes({
  request,
  response,
  pathname,
  requestContext,
  state,
}: SearchRouteOptions): Promise<boolean> {
  if (request.method !== 'POST' || pathname !== '/api/workspace/search') {
    return false;
  }

  await withJsonBody(request, response, async (body) => {
    const result = searchWorkspaceIndex(parseWorkspaceSearchBody(body, state));
    sendJson(response, 200, {
      ...result,
      context: requestContext,
    });
  });
  return true;
}
