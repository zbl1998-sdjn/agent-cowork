// 会话路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/conversations/* —— 会话的列出/读取/创建/改名/删除(多租户隔离)。
// 依赖:L0 path-policy/request-utils + L1 storage 会话存储(经参数注入)。导出:handleConversationRoutes。
import { z } from 'zod';
import { AtRestKeyError } from '../security/at-rest.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type {
  ConversationInput,
  ConversationListFullOptions,
  ConversationQueryOptions,
  ConversationQueryResult,
} from '../storage/conversation-types.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type RequestContext = { tenantId?: string; userId?: string; traceId?: string; [key: string]: unknown };
type ConversationStoreLike = {
  list(root: string, context: RequestContext): unknown[] | Promise<unknown[]>;
  get(root: string, id: string, context: RequestContext): unknown | Promise<unknown>;
  save(root: string, conversation: ConversationInput, context: RequestContext): unknown | Promise<unknown>;
  remove(root: string, id: string, context: RequestContext): boolean | Promise<boolean>;
  listFull?: (root: string, context: RequestContext, options?: ConversationListFullOptions) => unknown[] | Promise<unknown[]>;
  query?: (root: string, context: RequestContext, options?: ConversationQueryOptions) => ConversationQueryResult | Promise<ConversationQueryResult>;
};
type ConversationRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault: string;
  safeTrustedRoot(value?: unknown): string;
  conversationStore?: ConversationStoreLike | null;
};

const trustedRootSchema = z.preprocess(
  (value) => (value === '' || value == null ? undefined : value),
  z.string().optional(),
);
const listQuerySchema = z.object({
  trustedRoot: trustedRootSchema,
  full: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().optional(),
}).loose();
const conversationBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  messages: z.unknown().optional(),
  activeBranchId: z.unknown().optional(),
  branches: z.unknown().optional(),
}).loose();

function errorStatus(err: unknown, fallback: number): number {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as RouteError).statusCode === 'number'
    ? (err as RouteError).statusCode ?? fallback
    : fallback;
}

function errorMessage(err: unknown, fallback = 'invalid conversation request'): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || fallback;
  return err instanceof Error ? err.message : String(err);
}

function errorPayload(err: unknown): { error: string; code?: string } {
  const error = errorMessage(err);
  return err instanceof AtRestKeyError ? { error, code: err.code } : { error };
}

function resolveRoot(raw: unknown, safeTrustedRoot: (value?: unknown) => string): string {
  if (raw != null && raw !== '' && typeof raw !== 'string') {
    throw new Error('trustedRoot must be a string');
  }
  return safeTrustedRoot(raw);
}

function resolveRootOrSend(
  response: HttpResponseLike,
  raw: unknown,
  safeTrustedRoot: (value?: unknown) => string,
): string | null {
  try {
    return resolveRoot(raw, safeTrustedRoot);
  } catch (err) {
    sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    return null;
  }
}

function normalizeListQuery(requestUrl: URL): z.infer<typeof listQuerySchema> {
  return listQuerySchema.parse(Object.fromEntries(requestUrl.searchParams.entries()));
}

function normalizeLimit(value: number | undefined): number | undefined {
  return value != null ? Math.min(Math.max(value || 0, 1), 200) : undefined;
}

export async function handleConversationRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  safeTrustedRoot,
  conversationStore,
}: ConversationRouteOptions): Promise<boolean> {
  if (!conversationStore || !pathname.startsWith('/api/conversations')) {
    return false;
  }

  if (request.method === 'GET' && pathname === '/api/conversations') {
    let query: z.infer<typeof listQuerySchema>;
    try {
      query = normalizeListQuery(requestUrl);
    } catch (err) {
      sendJson(response, 400, { error: errorMessage(err) });
      return true;
    }
    const safeRoot = resolveRootOrSend(response, query.trustedRoot, safeTrustedRoot);
    if (!safeRoot) return true;
    const full = query.full === '1';
    const limit = normalizeLimit(query.limit);

    if (full && typeof conversationStore.listFull === 'function') {
      const conversations = await conversationStore.listFull(safeRoot, requestContext, omitUndefined({ limit }));
      sendJson(response, 200, { conversations, context: requestContext });
      return true;
    }
    // 分页与搜索摘要留在存储层,这样租户/用户隔离和未来后端都共享同一契约。
    if (typeof conversationStore.query === 'function') {
      const offset = Math.max(query.offset || 0, 0);
      const { items, total } = await conversationStore.query(safeRoot, requestContext, {
        q: query.q || '',
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
      const safeRoot = resolveRootOrSend(response, requestUrl.searchParams.get('trustedRoot'), safeTrustedRoot);
      if (!safeRoot) return true;
      try {
        const conversation = await conversationStore.get(safeRoot, id, requestContext);
        if (!conversation) {
          sendJson(response, 404, { error: 'conversation not found' });
        } else {
          sendJson(response, 200, { conversation });
        }
      } catch (err) {
        sendJson(response, errorStatus(err, 400), errorPayload(err));
      }
      return true;
    }

    if (request.method === 'PUT') {
      await withJsonBody(request, response, async (body) => {
        const parsed = conversationBodySchema.safeParse(body);
        if (!parsed.success) {
          sendJson(response, 400, { error: errorMessage(parsed.error) });
          return;
        }
        const input = parsed.data;
        const safeRoot = resolveRoot(input.trustedRoot, safeTrustedRoot);
        try {
          const summary = await conversationStore.save(
            safeRoot,
            {
              id,
              title: input.title,
              pinned: input.pinned,
              messages: input.messages,
              activeBranchId: input.activeBranchId,
              branches: input.branches,
            },
            requestContext,
          );
          sendJson(response, 200, { conversation: summary });
        } catch (err) {
          sendJson(response, errorStatus(err, 400), errorPayload(err));
        }
      });
      return true;
    }

    if (request.method === 'DELETE') {
      const safeRoot = resolveRootOrSend(response, requestUrl.searchParams.get('trustedRoot'), safeTrustedRoot);
      if (!safeRoot) return true;
      try {
        const deleted = await conversationStore.remove(safeRoot, id, requestContext);
        sendJson(response, 200, { deleted });
      } catch (err) {
        sendJson(response, errorStatus(err, 400), errorPayload(err));
      }
      return true;
    }
  }

  return false;
}
