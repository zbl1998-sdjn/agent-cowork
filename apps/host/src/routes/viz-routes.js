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

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../http/middleware/common.js').RequestContext} RequestContext
 * @typedef {import('../artifacts/viz.js').VizSpec} VizSpec
 * @typedef {{ source?: string, name?: string, risk?: unknown, mutating?: boolean, requiresApproval?: boolean }} ToolDescriptor
 * @typedef {{ type: string, path: string, [key: string]: unknown }} FileOperationLike
 * @typedef {{ id: string, relativePath: string, dataUrl: string, viewUrl: string, operations: FileOperationLike[] }} VizApprovalPlan
 * @typedef {{ issue(input: unknown): string, consume(id: unknown, input: unknown): unknown }} FileOperationApprovalsLike
 * @typedef {{ descriptor(name: string): ToolDescriptor | null | undefined, call(name: string, args: Record<string, unknown>, ctx: { trustedRoot: string, context?: unknown }): unknown | Promise<unknown> }} ToolRegistryLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, trustedRootDefault: string, safeTrustedRoot(input?: unknown): string, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, toolRegistry?: ToolRegistryLike | null, fileOperationApprovals: FileOperationApprovalsLike }} VizRouteOptions
 * @typedef {Error & { statusCode?: number }} HttpError
 */

/** @param {unknown} body @returns {Record<string, unknown>} */
function objectBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? /** @type {Record<string, unknown>} */ (body)
    : {};
}

/** @param {unknown} err @returns {number} */
function errorStatus(err) {
  return Number(/** @type {Partial<HttpError>} */ (err)?.statusCode) || 400;
}

/** @param {unknown} err @returns {string} */
function errorMessage(err) {
  return /** @type {Partial<HttpError>} */ (err)?.message || String(err || 'request failed');
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

/** @param {unknown} body @returns {VizSpec} */
function vizFromBody(body) {
  const input = objectBody(body);
  return {
    title: typeof input.title === 'string' ? input.title : undefined,
    kind: typeof input.kind === 'string' ? input.kind : undefined,
    data: input.data,
    options: input.options,
    code: typeof input.code === 'string' ? input.code : undefined,
    definition: typeof input.definition === 'string' ? input.definition : undefined,
  };
}

/** @param {{ trustedRoot: string, body: Record<string, unknown>, viz: VizSpec }} options @returns {VizApprovalPlan} */
function buildVizRenderApprovalPlan({ trustedRoot, body, viz }) {
  const spec = normalizeLiveArtifactSpec({
    id: typeof body.id === 'string' ? body.id : undefined,
    title: viz.title,
    viz,
    dataSource: body.dataSource,
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

/** @param {VizRouteOptions} options @returns {Promise<boolean>} */
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
      const input = objectBody(body);
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const viz = vizFromBody(input);
      let plan;
      try {
        plan = buildVizRenderApprovalPlan({ trustedRoot, body: input, viz });
      } catch (err) {
        sendJson(response, errorStatus(err), { error: errorMessage(err) });
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
      const input = objectBody(body);
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const viz = vizFromBody(input);
      let html;
      try {
        html = renderViz(viz);
      } catch (err) {
        sendJson(response, errorStatus(err), { error: errorMessage(err) });
        return;
      }
      /** @type {Record<string, unknown>} */
      const payload = { context: requestContext, kind: String(viz.kind || '').toLowerCase(), html };
      if (input.persist !== false) {
        const trustedRoot = safeTrustedRoot(input.trustedRoot);
        const approvalPlan = buildVizRenderApprovalPlan({ trustedRoot, body: input, viz });
        fileOperationApprovals.consume(input.fileOperationApprovalId || input.approvalId, {
          kind: VIZ_RENDER_APPROVAL_KIND,
          trustedRoot,
          operations: approvalPlan.operations,
          context: requestContext,
        });
        let artifact;
        try {
          artifact = buildLiveArtifact({ trustedRoot, id: approvalPlan.id, title: viz.title, viz, dataSource: input.dataSource });
        } catch (err) {
          sendJson(response, errorStatus(err), { error: errorMessage(err) });
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
      sendJson(response, errorStatus(err), { error: errorMessage(err) });
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
      sendJson(response, errorStatus(err), { error: errorMessage(err) });
    }
    return true;
  }

  return false;
}
