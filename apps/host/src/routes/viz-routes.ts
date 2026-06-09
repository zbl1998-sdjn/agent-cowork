// 可视化路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/viz/* —— 把图表规格渲染为可视化(chart/mermaid/table),或落成活页制品。
// 依赖:L0 request-utils + L1 artifacts/viz/live-artifact + L2 文件操作审批。导出:handleVizRoutes。
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { renderViz } from '../artifacts/viz.js';
import { buildLiveArtifact, readLiveArtifactHtml, refreshLiveArtifactDataAsync } from '../artifacts/live-artifact.js';
import { artifactPaths, normalizeLiveArtifactSpec, resolveLiveArtifactDataSourcePath } from '../artifacts/live-spec.js';
import { omitUndefined } from '../util/object.js';
import { errorMessage, errorStatus } from './route-error-utils.js';
import {
  parseArtifactIdPath,
  parseVizBody,
} from './viz-route-schemas.js';
import { sendHtml } from './viz-route-support.js';
import type { z } from 'zod';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { RequestContext } from '../http/middleware/common.js';
import type { VizSpec } from '../artifacts/viz.js';
import type { ToolRegistryLike } from '../artifacts/live-refresh.js';
import type { vizRenderBodySchema } from './viz-route-schemas.js';
import type {
  FileOperationApprovalRequest,
  FileOperationApprovalStore,
} from '../runtime/file-operation-approvals.js';

// 内联可视化与 live artifact 路由:渲染预览、经审批持久化 HTML/manifest,并提供数据刷新与页面读取端点。
// POST 通过共享缓存保持幂等;已保存页面的刷新按钮再走 data 端点拿最新数据。

const DATA_PREFIX = '/api/artifacts/data/';
const LIVE_PREFIX = '/api/artifacts/live/';
const VIZ_RENDER_APPROVAL_KIND = 'viz:render';

type RouteRequest = HttpRequestLike & { method?: string };
type VizRouteBody = z.output<typeof vizRenderBodySchema>;
type FileOperationLike = FileOperationApprovalRequest['operations'];
type VizApprovalPlan = {
  id: string;
  relativePath: string;
  dataUrl: string;
  viewUrl: string;
  operations: FileOperationLike;
};
type VizRequestContext = RequestContext & { idempotencyKey?: string; [key: string]: unknown };
type VizRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: VizRequestContext;
  trustedRootDefault: string;
  safeTrustedRoot(input?: unknown): string;
  cacheKeyFor(context: VizRequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: VizRequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | undefined;
  toolRegistry?: ToolRegistryLike | null;
  fileOperationApprovals: Pick<FileOperationApprovalStore, 'issue' | 'consume'>;
};

function vizFromBody(input: VizRouteBody): VizSpec {
  return omitUndefined({
    title: input.title,
    kind: input.kind,
    data: input.data,
    options: input.options,
    code: input.code,
    definition: input.definition,
  });
}

function buildVizRenderApprovalPlan({ trustedRoot, body, viz }: {
  trustedRoot: string;
  body: VizRouteBody;
  viz: VizSpec;
}): VizApprovalPlan {
  const spec = normalizeLiveArtifactSpec(omitUndefined({
    id: body.id,
    title: viz.title,
    viz,
    dataSource: body.dataSource,
  }));
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
}: VizRouteOptions): Promise<boolean> {
  if (request.method === 'POST' && pathname === '/api/viz/render/preview') {
    await withJsonBody(request, response, async (body) => {
      const input = parseVizBody(response, body, 'invalid viz preview request');
      if (!input) return;
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const viz = vizFromBody(input);
      let plan;
      try {
        plan = buildVizRenderApprovalPlan({ trustedRoot, body: input, viz });
      } catch (err) {
        sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
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
      const input = parseVizBody(response, body, 'invalid viz render request');
      if (!input) return;
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
        sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
        return;
      }
      const payload: Record<string, unknown> = { context: requestContext, kind: String(viz.kind || '').toLowerCase(), html };
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
          artifact = buildLiveArtifact(omitUndefined({ trustedRoot, id: approvalPlan.id, title: viz.title, viz, dataSource: input.dataSource }));
        } catch (err) {
          sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
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
    const id = parseArtifactIdPath(response, pathname, DATA_PREFIX);
    if (!id) return true;
    try {
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      const artifactData = await refreshLiveArtifactDataAsync(omitUndefined({
        trustedRoot,
        id,
        toolRegistry,
        context: requestContext,
      }));
      sendJson(response, 200, {
        context: requestContext,
        ...artifactData,
      });
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith(LIVE_PREFIX)) {
    const id = parseArtifactIdPath(response, pathname, LIVE_PREFIX);
    if (!id) return true;
    try {
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      const html = readLiveArtifactHtml({ trustedRoot, id });
      sendHtml(response, 200, html);
    } catch (err) {
      sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
    }
    return true;
  }

  return false;
}
