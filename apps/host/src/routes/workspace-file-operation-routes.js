// 工作区文件操作路由(host · L3 路由层):预览/执行/回滚批量文件操作,统一走审批与幂等缓存。
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { previewFileOperations, applyFileOperations, rollbackFileOperations } from '../workspace/file-operations.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {{ trustedRoot?: string, operations?: unknown, fileOperationApprovalId?: unknown, approvalId?: unknown, rollbackApprovalId?: unknown, rollback?: unknown, applied?: unknown }} FileOpsBody
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: Record<string, unknown>, config: { journalWriter?: { append(event: unknown): unknown } }, cacheKeyFor(context: Record<string, unknown>, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: Record<string, unknown>): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string, fileOperationApprovals: { issue(input: unknown): string, consume(id: unknown, input: unknown): unknown } }} WorkspaceFileOperationRouteOptions
 */

/** @param {RouteRequest} request @param {RouteResponse} response @param {(body: FileOpsBody) => void | Promise<void>} handler */
function withFileOpsBody(request, response, handler) {
  return withJsonBody(request, response, (body) => handler(/** @type {FileOpsBody} */ (body || {})));
}

/** @param {WorkspaceFileOperationRouteOptions} options */
export async function handleWorkspaceFileOperationRoutes({
  request,
  response,
  pathname,
  requestContext,
  config,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
  fileOperationApprovals,
}) {
  if (request.method === 'POST' && pathname === '/api/file-ops/preview') {
    await withFileOpsBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const preview = previewFileOperations(body.operations, { trustedRoot });
      const fileOperationApprovalId = preview.operations.length
        ? fileOperationApprovals.issue({
          kind: 'file-ops:apply',
          trustedRoot,
          operations: preview.operations,
          context: requestContext,
        })
        : null;
      sendJson(response, 200, { ...preview, fileOperationApprovalId });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/apply') {
    await withFileOpsBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const preview = previewFileOperations(body.operations, { trustedRoot });
      fileOperationApprovals.consume(body.fileOperationApprovalId || body.approvalId, {
        kind: 'file-ops:apply',
        trustedRoot,
        operations: preview.operations,
        context: requestContext,
      });
      const applied = applyFileOperations(body.operations, {
        trustedRoot,
        journalWriter: config.journalWriter,
      });
      const rollbackApprovalId = applied.applied.length
        ? fileOperationApprovals.issue({
          kind: 'file-ops:rollback',
          trustedRoot,
          operations: applied.applied,
          context: requestContext,
        })
        : null;
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        ...applied,
        rollbackApprovalId,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/rollback') {
    await withFileOpsBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const entries = body.rollback || body.applied || body.operations;
      fileOperationApprovals.consume(body.rollbackApprovalId || body.fileOperationApprovalId || body.approvalId, {
        kind: 'file-ops:rollback',
        trustedRoot,
        operations: entries,
        context: requestContext,
      });
      const rollback = rollbackFileOperations(entries, {
        trustedRoot,
        journalWriter: config.journalWriter,
      });
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        ...rollback,
        context: requestContext,
      });
    });
    return true;
  }

  return false;
}
