import { bodyFingerprint, decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ tenantId?: string, userId?: string, traceId?: string, idempotencyKey?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ id: string, name: string, color: unknown | null, archived: boolean, createdAt: number, updatedAt: number }} ProjectRecord
 * @typedef {{ create(input?: { name?: unknown, color?: unknown }): ProjectRecord, rename(id: string, name: unknown): ProjectRecord, setColor(id: string, color: unknown): ProjectRecord, archive(id: string): ProjectRecord, unarchive(id: string): ProjectRecord, remove(id: string): boolean, get(id: string): ProjectRecord | null, list(options?: { includeArchived?: boolean }): ProjectRecord[], assignConversation(projectId: string, conversationId: unknown): void, unassignConversation(conversationId: unknown): boolean, conversationsOf(projectId: string): string[], assignArtifact(projectId: string, artifactId: unknown): void, unassignArtifact(artifactId: unknown): boolean, artifactsOf(projectId: string): string[], stats(id: string): { conversations: number, artifacts: number } }} ProjectStoreLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, trustedRootDefault: string, safeTrustedRoot(input?: unknown): string, getProjectStore(root: string, context: RequestContext): ProjectStoreLike, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void }} ProjectRouteOptions
 */

/** @param {ProjectStoreLike} store @param {ProjectRecord} project */
function withProjectStats(store, project) {
  return {
    ...project,
    stats: store.stats(project.id),
    conversations: store.conversationsOf(project.id),
    artifacts: store.artifactsOf(project.id),
  };
}

/** @param {unknown} err @param {number} fallback */
function errorStatus(err, fallback) {
  return err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
    ? err.statusCode
    : fallback;
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {ProjectRouteOptions} options @param {unknown} rootInput */
function scopedStore(options, rootInput) {
  const root = options.safeTrustedRoot(rootInput || options.trustedRootDefault);
  return { root, store: options.getProjectStore(root, options.requestContext) };
}

/** @param {ProjectRouteOptions} options @param {unknown} body @param {(input: Record<string, unknown>, store: ProjectStoreLike, root: string) => unknown} handler */
function cachedWrite(options, body, handler) {
  if (!options.requireIdempotencyKey(options.response, options.requestContext)) return;
  const input = /** @type {Record<string, unknown>} */ (body || {});
  const fingerprint = bodyFingerprint(input);
  const cacheKey = options.cacheKeyFor(options.requestContext, options.request.method, options.pathname);
  if (options.sendCachedOrStore(options.response, cacheKey, fingerprint, 200)) return;
  const { root, store } = scopedStore(options, input.trustedRoot);
  const payload = handler(input, store, root);
  options.sendCachedOrStore(options.response, cacheKey, fingerprint, 200, payload);
}

/** @param {ProjectRouteOptions} options @returns {Promise<boolean>} */
export async function handleProjectRoutes(options) {
  const { request, response, pathname, requestUrl } = options;
  if (!pathname.startsWith('/api/projects')) return false;

  if (request.method === 'GET' && pathname === '/api/projects') {
    try {
      const { root, store } = scopedStore(options, requestUrl.searchParams.get('trustedRoot'));
      const includeArchived = requestUrl.searchParams.get('includeArchived') === '1';
      const projects = store.list({ includeArchived }).map((project) => withProjectStats(store, project));
      sendJson(response, 200, { trustedRoot: root, projects });
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/projects') {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, (input, store, root) => ({
      trustedRoot: root,
      project: withProjectStats(store, store.create({ name: input.name, color: input.color })),
    })));
    return true;
  }

  const match = /^\/api\/projects\/([^/]+)(?:\/(conversations|artifacts)(?:\/([^/]+))?)?$/.exec(pathname);
  if (!match) return false;
  const id = decodePathSegment(match[1]);
  const collection = match[2] || '';
  const childId = match[3] ? decodePathSegment(match[3]) : null;
  if (!id || childId === null && match[3]) {
    sendJson(response, 400, { error: 'invalid project route' });
    return true;
  }

  if (request.method === 'GET' && !collection) {
    try {
      const { root, store } = scopedStore(options, requestUrl.searchParams.get('trustedRoot'));
      const project = store.get(id);
      if (!project) sendJson(response, 404, { error: 'project not found' });
      else sendJson(response, 200, { trustedRoot: root, project: withProjectStats(store, project) });
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  if (request.method === 'PATCH' && !collection) {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, (input, store, root) => {
      let project = store.get(id);
      if (!project) throw new Error('project not found');
      if ('name' in input) project = store.rename(id, input.name);
      if ('color' in input) project = store.setColor(id, input.color);
      if (input.archived === true) project = store.archive(id);
      if (input.archived === false) project = store.unarchive(id);
      return { trustedRoot: root, project: withProjectStats(store, project) };
    }));
    return true;
  }

  if (request.method === 'DELETE' && !collection) {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, (input, store, root) => ({
      trustedRoot: root,
      deleted: store.remove(id),
    })));
    return true;
  }

  if (request.method === 'POST' && collection) {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, (input, store, root) => {
      if (collection === 'conversations') store.assignConversation(id, input.conversationId);
      else store.assignArtifact(id, input.artifactId);
      const project = store.get(id);
      if (!project) throw new Error('project not found');
      return { trustedRoot: root, project: withProjectStats(store, project) };
    }));
    return true;
  }

  if (request.method === 'DELETE' && collection && childId) {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, (input, store, root) => {
      const removed = collection === 'conversations'
        ? store.unassignConversation(childId)
        : store.unassignArtifact(childId);
      const project = store.get(id);
      return { trustedRoot: root, removed, project: project ? withProjectStats(store, project) : null };
    }));
    return true;
  }

  return false;
}
