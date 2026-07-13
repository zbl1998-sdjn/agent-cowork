// Office/Web 可视化编辑路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:建立只读编辑会话；保存副本前签发文件操作审批，应用时重算预案并消费审批。
import { z } from 'zod';

import {
  buildArtifactEditorSavePlan,
  openArtifactEditorSession,
  publishArtifactEditorSavePlan,
} from '../artifacts/artifact-editor-service.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { FileOperationApprovalStore } from '../runtime/file-operation-approvals.js';

type RouteRequest = HttpRequestLike & { method?: string };
type ArtifactEditorRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  trustedRootDefault?: string;
  safeTrustedRoot(input?: unknown): string;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  fileOperationApprovals: Pick<FileOperationApprovalStore, 'issue' | 'consume'>;
};

const APPROVAL_KIND = 'artifact:save-visual-copy';
const sessionSchema = z.object({
  trustedRoot: z.unknown().optional(),
  path: z.string().min(1, 'artifact path is required'),
}).loose();
const saveSchema = sessionSchema.extend({
  revisionSha256: z.string().regex(/^[a-f0-9]{64}$/, 'valid revisionSha256 is required'),
  copyName: z.string().trim().min(1).max(180),
  changes: z.array(z.object({
    targetId: z.string().min(1).max(160),
    text: z.string().max(2 * 1024 * 1024),
  })).min(1).max(10_000),
  fileOperationApprovalId: z.string().max(160).optional(),
}).loose();

function parsedOrReply<T>(response: HttpResponseLike, result: z.ZodSafeParseResult<T>): T | null {
  if (result.success) return result.data;
  sendJson(response, 400, { error: result.error.issues[0]?.message || 'invalid artifact editor request' });
  return null;
}

export async function handleArtifactEditorRoutes(options: ArtifactEditorRouteOptions): Promise<boolean> {
  const { request, response, pathname, requestContext } = options;
  const isSession = request.method === 'POST' && pathname === '/api/artifacts/editor/session';
  const isPreview = request.method === 'POST' && pathname === '/api/artifacts/editor/save/preview';
  const isSave = request.method === 'POST' && pathname === '/api/artifacts/editor/save';
  if (!isSession && !isPreview && !isSave) return false;

  await withJsonBody(request, response, async (body) => {
    if (isSession) {
      const input = parsedOrReply(response, sessionSchema.safeParse(body));
      if (!input) return;
      const trustedRoot = options.safeTrustedRoot(input.trustedRoot || options.trustedRootDefault);
      const session = openArtifactEditorSession({ trustedRoot, artifactPath: input.path, context: requestContext });
      sendJson(response, 200, { session });
      return;
    }
    const input = parsedOrReply(response, saveSchema.safeParse(body));
    if (!input) return;
    if (isSave && !options.requireIdempotencyKey(response, requestContext)) return;
    const trustedRoot = options.safeTrustedRoot(input.trustedRoot || options.trustedRootDefault);
    const cacheKey = options.cacheKeyFor(requestContext, request.method, pathname);
    const fingerprint = bodyFingerprint({ body, trustedRoot });
    if (isSave && options.sendCachedOrStore(response, cacheKey, fingerprint, 201)) return;
    const plan = buildArtifactEditorSavePlan({
      trustedRoot,
      artifactPath: input.path,
      context: requestContext,
      revisionSha256: input.revisionSha256,
      copyName: input.copyName,
      changes: input.changes,
    });
    if (isPreview) {
      const fileOperationApprovalId = options.fileOperationApprovals.issue({
        kind: APPROVAL_KIND,
        trustedRoot,
        operations: plan.operations,
        context: requestContext,
      });
      sendJson(response, 200, {
        path: plan.targetPath,
        name: plan.copyName,
        outputSha256: plan.outputSha256,
        fileOperationApprovalId,
      });
      return;
    }
    options.fileOperationApprovals.consume(input.fileOperationApprovalId, {
      kind: APPROVAL_KIND,
      trustedRoot,
      operations: plan.operations,
      context: requestContext,
    });
    publishArtifactEditorSavePlan({ trustedRoot, context: requestContext }, plan);
    const session = openArtifactEditorSession({ trustedRoot, artifactPath: plan.targetPath, context: requestContext });
    options.sendCachedOrStore(response, cacheKey, fingerprint, 201, {
      path: plan.targetPath,
      name: plan.copyName,
      outputSha256: plan.outputSha256,
      session,
    });
  }, { maxBytes: 3 * 1024 * 1024 });
  return true;
}
