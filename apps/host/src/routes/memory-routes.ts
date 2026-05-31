// 记忆路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/memory/* —— 记忆的写入/查询/分层读取与用户画像存取(多租户隔离)。
// 依赖:L0 path-policy/request-utils + L1 memory 存储(经参数注入)。导出:handleMemoryRoutes。
import path from 'node:path';
import { z } from 'zod';
import { MEMORY_LIMITS } from '../memory/memory-constants.js';
import { createUserProfile } from '../memory/profile.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { MemoryStoreLike as ProfileMemoryStoreLike } from '../memory/profile.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type RequestContext = { traceId?: string; tenantId?: string; userId?: string; idempotencyKey?: string; [key: string]: unknown };
type MemoryNote = { name: string; size: number; modifiedAt: string; path?: string };
type MemoryFact = { key: string; value: string; scope: string };
type MemoryFactResult = { file: string; fact: MemoryFact };
type MemoryStoreLike = ProfileMemoryStoreLike & {
  readMainMemory(trustedRoot: string, context?: RequestContext): string | Promise<string>;
  listMemoryNotes(trustedRoot: string, context?: RequestContext): MemoryNote[] | Promise<MemoryNote[]>;
  appendMemoryFact(
    trustedRoot: string,
    fact: { key?: unknown; value?: unknown; scope?: unknown },
    context?: RequestContext,
  ): MemoryFactResult | Promise<MemoryFactResult>;
};
type MemoryRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault: string;
  memoryStore: MemoryStoreLike;
};

const trustedRootSchema = z.preprocess(
  (value) => (value === '' || value == null ? undefined : value),
  z.string().optional(),
);
const profileQuerySchema = z.object({
  trustedRoot: trustedRootSchema,
  query: z.string().optional(),
  limit: z.coerce.number().int().finite().catch(8),
}).passthrough();
const factBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  key: z.string().trim().min(1, 'memory fact key is required'),
  value: z.string().trim().min(1, 'memory fact value is required'),
  scope: z.string().optional(),
}).passthrough();
const profileLearnBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  entry: z.unknown().optional(),
}).passthrough();
const profileForgetBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  type: z.unknown().optional(),
  key: z.unknown().optional(),
}).passthrough();
const noteBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  name: z.string().trim().min(1, 'body.name is required'),
  body: z.string(),
}).passthrough();

function errorStatus(err: unknown, fallback: number): number {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as RouteError).statusCode === 'number'
    ? (err as RouteError).statusCode ?? fallback
    : fallback;
}

function errorMessage(err: unknown, fallback = 'invalid memory request'): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || fallback;
  return err instanceof Error ? err.message : String(err);
}

function safeMemoryRoot(value: unknown, trustedRootDefault: string): string {
  if (value != null && value !== '' && typeof value !== 'string') {
    throw new Error('trustedRoot must be a string');
  }
  const trustedRoot = path.resolve(value || trustedRootDefault);
  return assertTrustedPath(trustedRoot, trustedRootDefault);
}

function safeMemoryRootOrSend(value: unknown, trustedRootDefault: string, response: HttpResponseLike): string | null {
  try {
    return safeMemoryRoot(value, trustedRootDefault);
  } catch (err) {
    sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    return null;
  }
}

export async function handleMemoryRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  trustedRootDefault,
  memoryStore,
}: MemoryRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/memory') {
    const safeRoot = safeMemoryRootOrSend(requestUrl.searchParams.get('trustedRoot'), trustedRootDefault, response);
    if (!safeRoot) return true;
    const main = await memoryStore.readMainMemory(safeRoot, requestContext);
    const notes = (await memoryStore.listMemoryNotes(safeRoot, requestContext)).map((note) => ({
      name: note.name,
      size: note.size,
      modifiedAt: note.modifiedAt,
    }));
    sendJson(response, 200, {
      trustedRoot: safeRoot,
      memory: {
        enabled: Boolean(main.trim()),
        bytes: Buffer.byteLength(main, 'utf8'),
        text: main,
        notes,
      },
      limits: MEMORY_LIMITS,
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/memory/profile') {
    let query: z.infer<typeof profileQuerySchema>;
    try {
      query = profileQuerySchema.parse(Object.fromEntries(requestUrl.searchParams.entries()));
    } catch (err) {
      sendJson(response, 400, { error: errorMessage(err) });
      return true;
    }
    const safeRoot = safeMemoryRootOrSend(query.trustedRoot, trustedRootDefault, response);
    if (!safeRoot) return true;
    const profile = createUserProfile({ memoryStore });
    const loaded = await profile.load(safeRoot, requestContext);
    const recall = await profile.recall(safeRoot, {
      query: query.query || '',
      limit: query.limit,
      context: requestContext,
    });
    sendJson(response, 200, { trustedRoot: safeRoot, profile: loaded, recall, context: requestContext });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/facts') {
    await withJsonBody(request, response, async (body) => {
      const parsed = factBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const input = parsed.data;
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const result = await memoryStore.appendMemoryFact(
        safeRoot,
        { key: input.key, value: input.value, scope: input.scope },
        requestContext,
      );
      sendJson(response, 200, {
        trustedRoot: safeRoot,
        fact: result.fact,
        file: result.file,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/profile/learn') {
    await withJsonBody(request, response, async (body) => {
      const parsed = profileLearnBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const input = parsed.data;
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const profile = createUserProfile({ memoryStore });
      const learned = await profile.learn(safeRoot, input.entry || input, requestContext);
      sendJson(response, 200, { trustedRoot: safeRoot, profile: learned, context: requestContext });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/profile/forget') {
    await withJsonBody(request, response, async (body) => {
      const parsed = profileForgetBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const input = parsed.data;
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const profile = createUserProfile({ memoryStore });
      const forgetInput = input as { type?: unknown; key?: unknown };
      const result = await profile.forget(safeRoot, { type: forgetInput.type, key: forgetInput.key }, requestContext);
      sendJson(response, 200, { trustedRoot: safeRoot, ...result, context: requestContext });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/notes') {
    await withJsonBody(request, response, async (body) => {
      const parsed = noteBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const input = parsed.data;
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const written = await memoryStore.writeMemoryNote(safeRoot, input.name, input.body, requestContext);
      sendJson(response, 200, {
        trustedRoot: safeRoot,
        note: { name: input.name, path: written },
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/memory/notes/')) {
    const noteName = decodePathSegment(pathname.slice('/api/memory/notes/'.length));
    if (!noteName) {
      sendJson(response, 400, { error: 'Invalid memory note name' });
      return true;
    }
    const safeRoot = safeMemoryRootOrSend(requestUrl.searchParams.get('trustedRoot'), trustedRootDefault, response);
    if (!safeRoot) return true;
    const body = await memoryStore.readMemoryNote(safeRoot, noteName, requestContext);
    if (body == null) {
      sendJson(response, 404, { error: 'Memory note not found' });
      return true;
    }
    sendJson(response, 200, {
      trustedRoot: safeRoot,
      note: { name: noteName, body },
    });
    return true;
  }

  return false;
}
