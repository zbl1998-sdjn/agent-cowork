import { listArtifacts, renameArtifact, renderArtifactHtml } from '../artifacts/artifact-catalog.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';

function sendHtml(response, status, body) {
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
      sendJson(response, err.statusCode || 400, { error: err.message });
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
      sendJson(response, err.statusCode || 400, { error: err.message });
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
      const trustedRoot = safeTrustedRoot(body.trustedRoot || trustedRootDefault);
      const artifact = renameArtifact({
        trustedRoot,
        artifactPath: body.path,
        newName: body.newName,
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
