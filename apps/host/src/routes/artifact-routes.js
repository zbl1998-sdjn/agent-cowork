import { listArtifacts, renderArtifactHtml } from '../artifacts/artifact-catalog.js';
import { sendJson } from '../http/request-utils.js';

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

  return false;
}
