import { listArtifacts, renameArtifact, renderArtifactHtml } from '../artifacts/artifact-catalog.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ traceId?: string, tenantId?: string, userId?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ trustedRoot?: unknown, path?: string, newName?: unknown }} RenameBody
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, trustedRootDefault?: string, safeTrustedRoot(input?: unknown): string, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void }} ArtifactRouteOptions
 */

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

/** @param {RouteResponse} response @param {number} status @param {string} body */
function sendHtml(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** @param {ArtifactRouteOptions} options */
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
}) {
  if (request.method === 'GET' && pathname === '/api/artifacts') {
    try {
      const limit = Number(requestUrl.searchParams.get('limit') || 20);
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
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      const artifactPath = requestUrl.searchParams.get('path') || '';
      const html = renderArtifactHtml({ trustedRoot, artifactPath });
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
      const input = /** @type {RenameBody} */ (body || {});
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
