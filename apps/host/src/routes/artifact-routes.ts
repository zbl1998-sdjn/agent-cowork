// 制品路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/artifacts/* —— 列出制品、重命名、渲染活页制品 HTML(含实时刷新)。
// 依赖:L1 artifacts(artifact-catalog/live-artifact)。导出:handleArtifactRoutes。
import { z } from 'zod';
import { listArtifacts, renameArtifact, renderArtifactHtml } from '../artifacts/artifact-catalog.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type RequestContext = { traceId?: string; tenantId?: string; userId?: string; [key: string]: unknown };
type ArtifactRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault?: string;
  safeTrustedRoot(input?: unknown): string;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
};

const limitParamSchema = z.coerce.number().int().catch(20);
const artifactViewQuerySchema = z.object({
  trustedRoot: z.preprocess(
    (value) => (typeof value === 'string' && value.length > 0 ? value : undefined),
    z.string().optional(),
  ),
  path: z.string().min(1, 'artifact path is required'),
});
const renameBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    trustedRoot: z.unknown().optional(),
    path: z.string().min(1, 'artifact path is required'),
    newName: z.string().trim().min(1, 'artifact newName is required'),
  }).loose(),
);

function normalizeLimit(value: string | null): number {
  const parsed = limitParamSchema.parse(value || 20);
  return Math.max(1, Math.min(parsed, 100));
}

function errorStatus(err: unknown, fallback: number): number {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as RouteError).statusCode === 'number'
    ? (err as RouteError).statusCode as number
    : fallback;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendHtml(response: HttpResponseLike, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export async function handleArtifactRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  trustedRootDefault,
  safeTrustedRoot,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
}: ArtifactRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/artifacts') {
    try {
      const limit = normalizeLimit(requestUrl.searchParams.get('limit'));
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      sendJson(response, 200, {
        artifacts: listArtifacts({ trustedRoot, limit }),
        context: requestContext,
      });
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/artifacts/view') {
    try {
      const input = artifactViewQuerySchema.parse(Object.fromEntries(requestUrl.searchParams.entries()));
      const trustedRoot = safeTrustedRoot(input.trustedRoot || trustedRootDefault);
      const html = renderArtifactHtml({ trustedRoot, artifactPath: input.path });
      sendHtml(response, 200, html);
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/artifacts/rename') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const parsed = renameBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid artifact rename request' });
        return;
      }
      const input = parsed.data;
      const trustedRoot = safeTrustedRoot(input.trustedRoot || trustedRootDefault);
      const artifact = renameArtifact({
        trustedRoot,
        artifactPath: input.path,
        newName: input.newName,
      });
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        artifact,
        context: requestContext,
      });
    });
    return true;
  }

  return false;
}
