// 主题知识管理路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/memory/knowledge/* —— 列出(active+pending)、批准 pending→active、删除
//       误提炼条目。让用户在记忆面板看/管由对话自动提炼的主题知识(防污染的最后一道人控)。
//       与 memory-routes 拆开以守住单文件体积上限。
// 依赖:L0 path-policy/request-utils + L1 memory/knowledge-store。导出:handleMemoryKnowledgeRoutes。
import { z } from 'zod';
import { deleteKnowledgeItem, listKnowledgeItems, setKnowledgeItemStatus } from '../memory/knowledge-store.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = { traceId?: string; tenantId?: string; userId?: string; [key: string]: unknown };
type RouteError = Error & { statusCode?: number };
type MemoryKnowledgeRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  safeTrustedRoot(value?: unknown): string;
};

const idBodySchema = z.object({
  trustedRoot: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.string().optional()),
  id: z.string().trim().min(1, 'knowledge item id is required'),
}).loose();

function errorStatus(error: unknown): number {
  return error && typeof error === 'object' && 'statusCode' in error
    && typeof (error as RouteError).statusCode === 'number'
    ? (error as RouteError).statusCode ?? 400
    : 400;
}

function safeRoot(value: unknown, safeTrustedRoot: (value?: unknown) => string): string {
  if (value != null && value !== '' && typeof value !== 'string') throw new Error('trustedRoot must be a string');
  return safeTrustedRoot(value);
}

function safeRootOrSend(
  value: unknown,
  safeTrustedRoot: (value?: unknown) => string,
  response: HttpResponseLike,
): string | null {
  try {
    return safeRoot(value, safeTrustedRoot);
  } catch (err) {
    sendJson(response, errorStatus(err), { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function handleMemoryKnowledgeRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  safeTrustedRoot,
}: MemoryKnowledgeRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/memory/knowledge') {
    const root = safeRootOrSend(requestUrl.searchParams.get('trustedRoot'), safeTrustedRoot, response);
    if (!root) return true;
    const status = requestUrl.searchParams.get('status');
    const options: { status?: 'active' | 'pending' } = status === 'active' || status === 'pending' ? { status } : {};
    sendJson(response, 200, {
      trustedRoot: root,
      items: listKnowledgeItems(root, { ...options, context: requestContext }),
      context: requestContext,
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/knowledge/approve') {
    await withJsonBody(request, response, async (body) => {
      const parsed = idBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid request' });
        return;
      }
      const root = safeRoot(parsed.data.trustedRoot, safeTrustedRoot);
      const ok = setKnowledgeItemStatus(root, parsed.data.id, 'active', requestContext);
      sendJson(response, ok ? 200 : 404, ok
        ? { trustedRoot: root, id: parsed.data.id, status: 'active', context: requestContext }
        : { error: 'knowledge item not found' });
    });
    return true;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/memory/knowledge/')) {
    const id = decodePathSegment(pathname.slice('/api/memory/knowledge/'.length));
    if (!id) {
      sendJson(response, 400, { error: 'Invalid knowledge item id' });
      return true;
    }
    const root = safeRootOrSend(requestUrl.searchParams.get('trustedRoot'), safeTrustedRoot, response);
    if (!root) return true;
    const ok = deleteKnowledgeItem(root, id, requestContext);
    sendJson(response, ok ? 200 : 404, ok
      ? { trustedRoot: root, id, removed: true, context: requestContext }
      : { error: 'knowledge item not found' });
    return true;
  }

  return false;
}
