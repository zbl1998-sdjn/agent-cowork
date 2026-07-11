// Owner-scoped immutable live-artifact history and approved version publication (host · L3 routes).
import { z } from 'zod';
import { listArtifactVersions } from '../artifacts/artifact-version-chain.js';
import { buildLiveArtifactVersion } from '../artifacts/live-artifact.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import { buildArtifactVersionApprovalPlan } from './artifact-version-route-plan.js';
import { parseArtifactIdPath } from './viz-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { FileOperationApprovalStore } from '../runtime/file-operation-approvals.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type ArtifactVersionRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault?: string;
  safeTrustedRoot(input?: unknown): string;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string,
    status: number,
    payload?: unknown,
  ): boolean | undefined;
  fileOperationApprovals: Pick<FileOperationApprovalStore, 'issue' | 'consume'>;
  resolveSecurityMode?: () => unknown;
};

const HISTORY_PREFIX = '/api/artifacts/live/';
const HISTORY_SUFFIX = '/history';
const VERSION_APPROVAL_KIND = 'viz:publish-version';
const ARTIFACT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const APPROVAL_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const versionBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    id: z.string().trim().regex(ARTIFACT_ID_RE, 'artifact id contains unsupported characters').optional(),
    title: z.string().max(200).optional(),
    viz: z.object({ kind: z.string().trim().max(32).optional() }).loose().optional(),
    dataSource: z.unknown().optional(),
    trustedRoot: z.unknown().optional(),
    approvalId: z.string().trim().regex(APPROVAL_ID_RE).optional(),
    fileOperationApprovalId: z.string().trim().regex(APPROVAL_ID_RE).optional(),
  }).loose(),
);

function errorStatus(error: unknown): number {
  const status = (error as RouteError | null)?.statusCode;
  return typeof status === 'number' ? status : 400;
}

function parseWritePath(pathname: string): { encodedParentId: string; preview: boolean } | null {
  const match = /^\/api\/artifacts\/live\/([^/]+)\/versions(\/preview)?$/.exec(pathname);
  return match?.[1] ? { encodedParentId: match[1], preview: Boolean(match[2]) } : null;
}

export async function handleArtifactVersionRoutes({
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
  fileOperationApprovals,
  resolveSecurityMode,
}: ArtifactVersionRouteOptions): Promise<boolean> {
  if (request.method === 'GET'
    && pathname.startsWith(HISTORY_PREFIX)
    && pathname.endsWith(HISTORY_SUFFIX)) {
    const encodedId = pathname.slice(HISTORY_PREFIX.length, -HISTORY_SUFFIX.length);
    const id = parseArtifactIdPath(response, encodedId, '');
    if (!id) return true;
    try {
      const trustedRoot = safeTrustedRoot(requestUrl.searchParams.get('trustedRoot') || trustedRootDefault);
      sendJson(response, 200, {
        artifactId: id,
        versions: listArtifactVersions({ trustedRoot, id, context: requestContext }),
      });
    } catch (error) {
      sendJson(response, errorStatus(error), {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  const writePath = request.method === 'POST' ? parseWritePath(pathname) : null;
  if (!writePath) return false;
  const parentVersionId = parseArtifactIdPath(response, writePath.encodedParentId, '');
  if (!parentVersionId) return true;
  await withJsonBody(request, response, async (body) => {
    if (!writePath.preview && !requireIdempotencyKey(response, requestContext)) return;
    const parsed = versionBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid artifact version request' });
      return;
    }
    const input = parsed.data;
    const draft = omitUndefined({
      id: input.id,
      title: input.title,
      viz: input.viz ? omitUndefined(input.viz) : undefined,
      dataSource: input.dataSource,
    });
    if (!writePath.preview && !input.id) {
      sendJson(response, 400, { error: 'artifact version id is required after preview' });
      return;
    }
    const trustedRoot = safeTrustedRoot(input.trustedRoot || trustedRootDefault);
    const fingerprint = bodyFingerprint({ body, trustedRoot });
    const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
    if (!writePath.preview && sendCachedOrStore(response, cacheKey, fingerprint, 201)) return;
    const securityMode = resolveSecurityMode?.();
    const plan = buildArtifactVersionApprovalPlan({
      trustedRoot,
      parentVersionId,
      draft,
      context: requestContext,
      securityMode,
    });
    if (writePath.preview) {
      const fileOperationApprovalId = fileOperationApprovals.issue({
        kind: VERSION_APPROVAL_KIND,
        trustedRoot,
        operations: plan.operations,
        context: requestContext,
      });
      sendJson(response, 200, {
        id: plan.id,
        parentVersionId: plan.parentVersionId,
        relativePath: plan.relativePath,
        dataUrl: plan.dataUrl,
        viewUrl: plan.viewUrl,
        title: plan.title,
        vizKind: plan.viz.kind,
        dataSourceType: plan.dataSourceType,
        parentContentSha256: plan.parentContentSha256,
        approvalPlanSha256: bodyFingerprint(plan.operations),
        operationCount: plan.operations.length,
        fileOperationApprovalId,
      });
      return;
    }
    fileOperationApprovals.consume(input.fileOperationApprovalId || input.approvalId, {
      kind: VERSION_APPROVAL_KIND,
      trustedRoot,
      operations: plan.operations,
      context: requestContext,
    });
    const artifact = buildLiveArtifactVersion(omitUndefined({
      trustedRoot,
      parentVersionId,
      id: plan.id,
      title: plan.title,
      viz: plan.viz,
      dataSource: plan.dataSource,
      securityMode,
      context: requestContext,
    }));
    sendCachedOrStore(response, cacheKey, fingerprint, 201, {
      id: artifact.id,
      parentVersionId: plan.parentVersionId,
      lineageId: plan.lineageId,
      relativePath: artifact.relativePath,
      dataUrl: artifact.dataUrl,
      viewUrl: plan.viewUrl,
    });
  });
  return true;
}
