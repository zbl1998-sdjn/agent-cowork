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
}) {
  if (request.method === 'POST' && pathname === '/api/files/tree') {
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
      if (!body || typeof body.path !== 'string' || !body.path.trim()) {
        throw new Error('body.path is required');
      }
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      try {
        const preview = readFilePreview(body.path, { trustedRoot, maxBytes: body.maxBytes });
        sendJson(response, 200, preview);
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/extract') {
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
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
    await withJsonBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const preview = previewFileOperations(body.operations, { trustedRoot });
      sendJson(response, 200, preview);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/apply') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const applied = applyFileOperations(body.operations, {
        trustedRoot,
        journalWriter: config.journalWriter,
      });
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        ...applied,
        context: requestContext,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/rollback') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const rollback = rollbackFileOperations(body.rollback || body.applied || body.operations, {
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
    await withJsonBody(request, response, async (body) => {
      const trustedRoot = safeTrustedRoot(body && body.trustedRoot);
      const result = buildAttachmentContext({ files: body && body.files, trustedRoot, maxSize: body && body.maxSize });
      sendJson(response, 200, { context: requestContext, ...result });
    });
    return true;
  }

  return false;
}
