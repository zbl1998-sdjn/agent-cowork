import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { renderViz } from '../artifacts/viz.js';
import { buildLiveArtifact, readLiveArtifactHtml, refreshLiveArtifactDataAsync } from '../artifacts/live-artifact.js';
import { artifactPaths, normalizeLiveArtifactSpec, resolveLiveArtifactDataSourcePath } from '../artifacts/live-spec.js';

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
const VIZ_RENDER_APPROVAL_KIND = 'viz:render';

function sendHtml(response, status, body) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function vizFromBody(body) {
  return {
    title: body?.title,
    kind: body?.kind,
    data: body?.data,
    options: body?.options,
    code: body?.code,
    definition: body?.definition,
  };
}

function buildVizRenderApprovalPlan({ trustedRoot, body, viz }) {
  const spec = normalizeLiveArtifactSpec({
    id: body?.id,
    title: viz.title,
    viz,
    dataSource: body?.dataSource,
  });
  renderViz(spec.viz);
  if (spec.dataSource?.type === 'file-json') {
    resolveLiveArtifactDataSourcePath({ trustedRoot, dataSource: spec.dataSource });
  }
  const paths = artifactPaths({ trustedRoot, id: spec.id });
  const operationBase = {
    artifactId: spec.id,
    title: spec.title,
    kind: spec.kind,
    dataUrl: spec.dataUrl,
    viz: spec.viz,
    dataSource: spec.dataSource || null,
  };
  return {
    id: spec.id,
    relativePath: paths.relativePath,
    dataUrl: spec.dataUrl,
    viewUrl: `${LIVE_PREFIX}${spec.id}`,
    operations: [
      { ...operationBase, type: 'viz-artifact-html', path: paths.htmlPath },
      { ...operationBase, type: 'viz-artifact-manifest', path: paths.manifestPath },
    ],
  };
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
  toolRegistry,
  fileOperationApprovals,
}) {
  if (request.method === 'POST' && pathname === '/api/viz/render/preview') {
    await withJsonBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body?.trustedRoot);
      const viz = vizFromBody(body);
      let plan;
      try {
        plan = buildVizRenderApprovalPlan({ trustedRoot, body, viz });
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
        return;
      }
      const fileOperationApprovalId = fileOperationApprovals.issue({
        kind: VIZ_RENDER_APPROVAL_KIND,
        trustedRoot,
        operations: plan.operations,
        context: requestContext,
      });
      sendJson(response, 200, {
        context: requestContext,
        ...plan,
        fileOperationApprovalId,
      });
    });
    return true;
  }

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
      const viz = vizFromBody(body);
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
        const approvalPlan = buildVizRenderApprovalPlan({ trustedRoot, body, viz });
        fileOperationApprovals.consume(body.fileOperationApprovalId || body.approvalId, {
          kind: VIZ_RENDER_APPROVAL_KIND,
          trustedRoot,
          operations: approvalPlan.operations,
          context: requestContext,
        });
        let artifact;
        try {
          artifact = buildLiveArtifact({ trustedRoot, id: approvalPlan.id, title: viz.title, viz, dataSource: body?.dataSource });
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
      const artifactData = await refreshLiveArtifactDataAsync({
        trustedRoot,
        id,
        toolRegistry,
        context: requestContext,
      });
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
