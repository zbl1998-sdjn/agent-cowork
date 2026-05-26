import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaceTree } from '../workspace/file-tree.js';
import { readTextFile } from '../workspace/file-reader.js';
import { readFilePreview } from '../workspace/file-preview.js';
import { extractDocumentText } from '../workspace/document-extractor.js';
import { searchWorkspace } from '../workspace/file-search.js';
import { buildContextBundle } from '../workspace/context-bundle.js';
import { previewFileOperations, applyFileOperations, rollbackFileOperations } from '../workspace/file-operations.js';
import { importUploadedFiles } from '../workspace/uploads.js';
import { buildAttachmentContext } from '../workspace/attachment-context.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {{ root?: string, trustedRoot?: string, path?: string, files?: any[], includeFiles?: boolean, includeDirectories?: boolean, maxSize?: number, maxBytes?: number, query?: unknown, maxResults?: number, includeContent?: boolean, maxContentBytes?: number, paths?: string[], maxTextSize?: number, operations?: unknown, fileOperationApprovalId?: unknown, approvalId?: unknown, rollbackApprovalId?: unknown, rollback?: unknown, applied?: unknown }} WorkspaceBody
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: Record<string, unknown>, trustedRootDefault: string, config: { maxUploadJsonBytes?: number, journalWriter?: { append(event: unknown): unknown } }, cacheKeyFor(context: Record<string, unknown>, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: Record<string, unknown>): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string, fileOperationApprovals: { issue(input: unknown): string, consume(id: unknown, input: unknown): unknown } }} WorkspaceFileRouteOptions
 */

/** @param {RouteRequest} request @param {RouteResponse} response @param {(body: WorkspaceBody) => void | Promise<void>} handler @param {{ maxBytes?: number, requireJsonContentType?: boolean }} [options] */
function withWorkspaceBody(request, response, handler, options) { return withJsonBody(request, response, (body) => handler(/** @type {WorkspaceBody} */ (body || {})), options); }

/** @param {WorkspaceFileRouteOptions} options */
export async function handleWorkspaceFileRoutes({
  request,
  response,
  pathname,
  requestContext,
  trustedRootDefault,
  config,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
  fileOperationApprovals,
}) {
  if (request.method === 'POST' && pathname === '/api/files/tree') {
    await withWorkspaceBody(request, response, async (body) => {
      if (!body || typeof body.root !== 'string' || !body.root.trim()) {
        throw new Error('body.root is required');
      }
      const requestedRoot = path.resolve(body.root);
      const trustedRoot = assertTrustedPath(requestedRoot, trustedRootDefault);
      const tree = listWorkspaceTree(trustedRoot, {
        includeFiles: body.includeFiles !== false,
        includeDirectories: body.includeDirectories !== false,
      });
      sendJson(response, 200, { root: trustedRoot, files: tree });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/uploads/import') {
    await withWorkspaceBody(request, response, async (body) => {
      const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
      const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
      const imported = importUploadedFiles({
        trustedRoot: safeRoot,
        files: body.files,
      });
      sendJson(response, 200, imported);
    }, { maxBytes: config.maxUploadJsonBytes || 18 * 1024 * 1024 });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/read') {
    await withWorkspaceBody(request, response, async (body) => {
      if (!body || typeof body.path !== 'string' || !body.path.trim()) {
        throw new Error('body.path is required');
      }
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const file = readTextFile(body.path, {
        trustedRoot,
        maxSize: body.maxSize,
      });
      sendJson(response, 200, file);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/preview') {
    await withWorkspaceBody(request, response, async (body) => {
      if (!body || typeof body.path !== 'string' || !body.path.trim()) {
        throw new Error('body.path is required');
      }
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      try {
        const preview = readFilePreview(body.path, { trustedRoot, maxBytes: body.maxBytes });
        sendJson(response, 200, preview);
      } catch (err) {
        const error = /** @type {Error & { statusCode?: number }} */ (err);
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/extract') {
    await withWorkspaceBody(request, response, async (body) => {
      if (!body || typeof body.path !== 'string' || !body.path.trim()) {
        throw new Error('body.path is required');
      }
      const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
      const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
      const extracted = extractDocumentText(body.path, {
        trustedRoot: safeRoot,
        maxSize: body.maxSize,
      });
      sendJson(response, 200, extracted);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/search') {
    await withWorkspaceBody(request, response, async (body) => {
      const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
      const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
      const results = searchWorkspace({
        trustedRoot: safeRoot,
        query: body.query,
        maxResults: body.maxResults,
        includeContent: body.includeContent,
        maxContentBytes: body.maxContentBytes,
      });
      sendJson(response, 200, results);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/context/bundle') {
    await withWorkspaceBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      if (!Array.isArray(body.paths)) {
        throw new Error('body.paths must be an array');
      }
      const bundle = buildContextBundle({
        root: trustedRoot,
        paths: body.paths,
        maxTextSize: body.maxTextSize,
        fsStatFn: (candidate) => {
          const safe = assertTrustedPath(candidate, trustedRoot);
          return fs.statSync(safe);
        },
      });
      sendJson(response, 200, bundle);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/preview') {
    await withWorkspaceBody(request, response, async (body) => {
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
    await withWorkspaceBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
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
    await withWorkspaceBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
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

  if (request.method === 'POST' && pathname === '/api/attachments/context') {
    await withWorkspaceBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body && body.trustedRoot);
      const result = buildAttachmentContext({ files: body && body.files, trustedRoot, maxSize: body && body.maxSize });
      sendJson(response, 200, { context: requestContext, ...result });
    });
    return true;
  }

  return false;
}
