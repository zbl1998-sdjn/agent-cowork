// 项目路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/projects/* —— 项目的增删查与切换(多租户隔离),写操作带幂等键去重。
// 依赖:L0 request-utils + L2 project-stores(经参数注入)。导出:handleProjectRoutes。
import { z } from 'zod';
import { bodyFingerprint, decodePathSegment, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { ProjectRecord, ProjectStore } from '../storage/projects.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type RequestContext = { tenantId?: string; userId?: string; traceId?: string; idempotencyKey?: string; [key: string]: unknown };
type ProjectWithStats = ProjectRecord & {
  stats: { conversations: number; artifacts: number };
  conversations: string[];
  artifacts: string[];
};
type ProjectWriteBody = { trustedRoot?: unknown; [key: string]: unknown };
type ProjectRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault: string;
  safeTrustedRoot(input?: unknown): string;
  getProjectStore(root: string, context: RequestContext): ProjectStore;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
};

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const baseWriteBodySchema = z.preprocess(
  objectBody,
  z.object({ trustedRoot: z.unknown().optional() }).passthrough(),
);
const createProjectBodySchema = baseWriteBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  name: z.unknown().optional(),
  color: z.unknown().optional(),
}).passthrough());
const updateProjectBodySchema = baseWriteBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  name: z.unknown().optional(),
  color: z.unknown().optional(),
  archived: z.boolean().optional(),
}).passthrough());
const conversationMembershipBodySchema = baseWriteBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  conversationId: z.string().min(1, 'conversationId is required'),
}).passthrough());
const artifactMembershipBodySchema = baseWriteBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  artifactId: z.string().min(1, 'artifactId is required'),
}).passthrough());

function withProjectStats(store: ProjectStore, project: ProjectRecord): ProjectWithStats {
  return {
    ...project,
    stats: store.stats(project.id),
    conversations: store.conversationsOf(project.id),
    artifacts: store.artifactsOf(project.id),
  };
}

function errorStatus(err: unknown, fallback: number): number {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as RouteError).statusCode === 'number'
    ? (err as RouteError).statusCode ?? fallback
    : fallback;
}

function errorMessage(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || 'invalid project request';
  return err instanceof Error ? err.message : String(err);
}

function scopedStore(options: ProjectRouteOptions, rootInput: unknown): { root: string; store: ProjectStore } {
  const root = options.safeTrustedRoot(rootInput || options.trustedRootDefault);
  return { root, store: options.getProjectStore(root, options.requestContext) };
}

function cachedWrite<T extends ProjectWriteBody>(
  options: ProjectRouteOptions,
  body: unknown,
  schema: z.ZodType<T>,
  handler: (input: T, store: ProjectStore, root: string) => unknown,
): void {
  if (!options.requireIdempotencyKey(options.response, options.requestContext)) return;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendJson(options.response, 400, { error: errorMessage(parsed.error) });
    return;
  }
  const input = parsed.data;
  const fingerprint = bodyFingerprint(input);
  const cacheKey = options.cacheKeyFor(options.requestContext, options.request.method, options.pathname);
  if (options.sendCachedOrStore(options.response, cacheKey, fingerprint, 200)) return;
  const { root, store } = scopedStore(options, input.trustedRoot);
  const payload = handler(input, store, root);
  options.sendCachedOrStore(options.response, cacheKey, fingerprint, 200, payload);
}

export async function handleProjectRoutes(options: ProjectRouteOptions): Promise<boolean> {
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
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, createProjectBodySchema, (input, store, root) => ({
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
  if (!id || (childId === null && match[3])) {
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
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, updateProjectBodySchema, (input, store, root) => {
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
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, baseWriteBodySchema, (input, store, root) => ({
      trustedRoot: root,
      deleted: store.remove(id),
    })));
    return true;
  }

  if (request.method === 'POST' && collection === 'conversations') {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, conversationMembershipBodySchema, (input, store, root) => {
      store.assignConversation(id, input.conversationId);
      const project = store.get(id);
      if (!project) throw new Error('project not found');
      return { trustedRoot: root, project: withProjectStats(store, project) };
    }));
    return true;
  }

  if (request.method === 'POST' && collection === 'artifacts') {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, artifactMembershipBodySchema, (input, store, root) => {
      store.assignArtifact(id, input.artifactId);
      const project = store.get(id);
      if (!project) throw new Error('project not found');
      return { trustedRoot: root, project: withProjectStats(store, project) };
    }));
    return true;
  }

  if (request.method === 'DELETE' && collection && childId) {
    await withJsonBody(request, response, async (body) => cachedWrite(options, body, baseWriteBodySchema, (input, store, root) => {
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
