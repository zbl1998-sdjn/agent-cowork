import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { renderViz } from '../artifacts/viz.js';
import { buildLiveArtifact, readLiveArtifactHtml, refreshLiveArtifactData } from '../artifacts/live-artifact.js';

// Inline-viz + live-artifact routes.
//
//   POST /api/viz/render          -> render a viz to HTML (show_widget); when
//                                    persist!=false, also save a live page +
//                                    manifest (create_artifact)
//   GET  /api/artifacts/data/:id  -> the live page's data endpoint (fresh viz)
//   GET  /api/artifacts/live/:id  -> serve a saved live page (text/html)
//
// POST is idempotent (replays through the shared cache); the live page's Refresh
// button calls the data endpoint, so a saved artifact stays current.

const DATA_PREFIX = '/api/artifacts/data/';
const LIVE_PREFIX = '/api/artifacts/live/';

function sendHtml(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

export async function handleVizRoutes({
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
  if (request.method === 'POST' && pathname === '/api/viz/render') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const viz = {
        title: body?.title,
        kind: body?.kind,
        data: body?.data,
        options: body?.options,
        code: body?.code,
        definition: body?.definition,
      };
      let html;
      try {
        html = renderViz(viz);
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
        return;
      }
      const payload = { context: requestContext, kind: String(viz.kind || '').toLowerCase(), html };
      if (body?.persist !== false) {
        const trustedRoot = safeTrustedRoot(body?.trustedRoot);
        let artifact;
        try {
          artifact = buildLiveArtifact({ trustedRoot, id: body?.id, title: viz.title, viz, dataSource: body?.dataSource });
        } catch (err) {
          sendJson(response, err.statusCode || 400, { error: err.message });
          return;
        }
        payload.persisted = true;
        payload.id = artifact.id;
        payload.relativePath = artifact.relativePath;
        payload.dataUrl = artifact.dataUrl;
        payload.viewUrl = `${LIVE_PREFIX}${artifact.id}`;
      } else {
        payload.persisted = false;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, payload);
    });
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith(DATA_PREFIX)) {
    const id = decodeURIComponent(pathname.slice(DATA_PREFIX.length));
    try {
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      const artifactData = refreshLiveArtifactData({ trustedRoot, id });
      sendJson(response, 200, {
        context: requestContext,
        ...artifactData,
      });
    } catch (err) {
      sendJson(response, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith(LIVE_PREFIX)) {
    const id = decodeURIComponent(pathname.slice(LIVE_PREFIX.length));
    try {
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      const html = readLiveArtifactHtml({ trustedRoot, id });
      sendHtml(response, 200, html);
    } catch (err) {
      sendJson(response, err.statusCode || 400, { error: err.message });
    }
    return true;
  }

  return false;
}
