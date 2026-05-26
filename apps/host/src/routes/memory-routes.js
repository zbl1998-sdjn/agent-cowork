import path from 'node:path';
import { MEMORY_LIMITS } from '../memory/memory-constants.js';
import { createUserProfile } from '../memory/profile.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ traceId?: string, tenantId?: string, userId?: string, idempotencyKey?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ name: string, size: number, modifiedAt: string, path?: string }} MemoryNote
 * @typedef {{ key: string, value: string, scope: string }} MemoryFact
 * @typedef {{ file: string, fact: MemoryFact }} MemoryFactResult
 * @typedef {{ trustedRoot?: unknown, key?: unknown, value?: unknown, scope?: unknown, entry?: unknown, name?: unknown, body?: unknown, type?: unknown }} MemoryBody
 * @typedef {{ readMainMemory(trustedRoot: string, context?: RequestContext): string | Promise<string>, listMemoryNotes(trustedRoot: string, context?: RequestContext): MemoryNote[] | Promise<MemoryNote[]>, readMemoryNote(trustedRoot: string, noteName: string, context?: RequestContext): string | null | Promise<string | null>, writeMemoryNote(trustedRoot: string, noteName: string, body: string, context?: RequestContext): string | Promise<string>, appendMemoryFact(trustedRoot: string, fact: { key?: unknown, value?: unknown, scope?: unknown }, context?: RequestContext): MemoryFactResult | Promise<MemoryFactResult> }} MemoryStoreLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, trustedRootDefault: string, memoryStore: MemoryStoreLike }} MemoryRouteOptions
 */

/** @param {unknown} value @param {string} trustedRootDefault @returns {string} */
function safeMemoryRoot(value, trustedRootDefault) {
  if (value != null && value !== '' && typeof value !== 'string') {
    throw new Error('trustedRoot must be a string');
  }
  const trustedRoot = path.resolve(value || trustedRootDefault);
  return assertTrustedPath(trustedRoot, trustedRootDefault);
}

/** @param {unknown} value @param {string} trustedRootDefault @param {RouteResponse} response @returns {string | null} */
function safeMemoryRootOrSend(value, trustedRootDefault, response) {
  try {
    return safeMemoryRoot(value, trustedRootDefault);
  } catch (err) {
    const error = /** @type {RouteError} */ (err);
    sendJson(response, error.statusCode || 400, { error: error.message });
    return null;
  }
}

/** @param {MemoryRouteOptions} options @returns {Promise<boolean>} */
export async function handleMemoryRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  trustedRootDefault,
  memoryStore,
}) {
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
    const safeRoot = safeMemoryRootOrSend(requestUrl.searchParams.get('trustedRoot'), trustedRootDefault, response);
    if (!safeRoot) return true;
    const profile = createUserProfile({ memoryStore });
    const loaded = await profile.load(safeRoot, requestContext);
    const recall = await profile.recall(safeRoot, {
      query: requestUrl.searchParams.get('query') || '',
      limit: Number(requestUrl.searchParams.get('limit') || 8),
      context: requestContext,
    });
    sendJson(response, 200, { trustedRoot: safeRoot, profile: loaded, recall, context: requestContext });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/facts') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {MemoryBody} */ (body || {});
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
      const input = /** @type {MemoryBody} */ (body || {});
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const profile = createUserProfile({ memoryStore });
      const learned = await profile.learn(safeRoot, input.entry || input, requestContext);
      sendJson(response, 200, { trustedRoot: safeRoot, profile: learned, context: requestContext });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/profile/forget') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {MemoryBody} */ (body || {});
      const safeRoot = safeMemoryRoot(input.trustedRoot, trustedRootDefault);
      const profile = createUserProfile({ memoryStore });
      const result = await profile.forget(safeRoot, input, requestContext);
      sendJson(response, 200, { trustedRoot: safeRoot, ...result, context: requestContext });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/memory/notes') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {MemoryBody} */ (body || {});
      if (typeof input.name !== 'string' || !input.name.trim()) {
        throw new Error('body.name is required');
      }
      if (typeof input.body !== 'string') {
        throw new Error('body.body must be a string');
      }
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
