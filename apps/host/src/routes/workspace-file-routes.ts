// 工作区文件路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/files/* 与 /api/workspace/* —— 列文件树、读/预览文件、上传、批量文件操作(预览+审批+apply)、回滚。
//       所有路径经 L0 path-policy 围栏;写操作走 L2 file-operation-approvals 审批。
// 依赖:L1 workspace(file-tree/reader/preview/uploads/operations)+ L2 审批(经参数注入)。导出:handleWorkspaceFileRoutes。
import fs from 'node:fs';
import path from 'node:path';
import { listWorkspaceTree } from '../workspace/file-tree.js';
import { readTextFile } from '../workspace/file-reader.js';
import { readFilePreview } from '../workspace/file-preview.js';
import { extractDocumentText } from '../workspace/document-extractor.js';
import { searchWorkspace } from '../workspace/file-search.js';
import { buildContextBundle } from '../workspace/context-bundle.js';
import { importUploadedFiles } from '../workspace/uploads.js';
import { buildAttachmentContext } from '../workspace/attachment-context.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { sendJson } from '../http/request-utils.js';
import { handleWorkspaceFileOperationRoutes } from './workspace-file-operation-routes.js';
import {
  attachmentContextBodySchema,
  contextBundleBodySchema,
  extractBodySchema,
  previewBodySchema,
  readBodySchema,
  searchBodySchema,
  treeBodySchema,
  uploadBodySchema,
  withParsedWorkspaceBody,
} from './workspace-file-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = Record<string, unknown>;
type JournalWriter = { append(event: unknown): unknown };
type FileOperationApprovals = {
  issue(input: unknown): string;
  consume(id: unknown, input: unknown): unknown;
};
type WorkspaceFileRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  trustedRootDefault: string;
  config: { maxUploadJsonBytes?: number; journalWriter?: JournalWriter };
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  safeTrustedRoot(input?: unknown): string;
  fileOperationApprovals: FileOperationApprovals;
};

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
}: WorkspaceFileRouteOptions): Promise<boolean> {
  if (request.method === 'POST' && pathname === '/api/files/tree') {
    await withParsedWorkspaceBody(request, response, treeBodySchema, 'invalid file tree request', async (body) => {
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
    await withParsedWorkspaceBody(request, response, uploadBodySchema, 'invalid upload import request', async (body) => {
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
    await withParsedWorkspaceBody(request, response, readBodySchema, 'invalid file read request', async (body) => {
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
    await withParsedWorkspaceBody(request, response, previewBodySchema, 'invalid file preview request', async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      try {
        const preview = readFilePreview(body.path, { trustedRoot, maxBytes: body.maxBytes });
        sendJson(response, 200, preview);
      } catch (err) {
        const error = err as Error & { statusCode?: number };
        sendJson(response, error.statusCode || 400, { error: error.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/files/extract') {
    await withParsedWorkspaceBody(request, response, extractBodySchema, 'invalid file extract request', async (body) => {
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
    await withParsedWorkspaceBody(request, response, searchBodySchema, 'invalid file search request', async (body) => {
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
    await withParsedWorkspaceBody(request, response, contextBundleBodySchema, 'invalid context bundle request', async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const bundle = buildContextBundle({
        root: trustedRoot,
        paths: body.paths,
        maxTextSize: body.maxTextSize,
        fsStatFn: (candidate: string) => {
          const safe = assertTrustedPath(candidate, trustedRoot);
          return fs.statSync(safe);
        },
      });
      sendJson(response, 200, bundle);
    });
    return true;
  }

  if (await handleWorkspaceFileOperationRoutes({
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
  })) {
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/attachments/context') {
    await withParsedWorkspaceBody(request, response, attachmentContextBodySchema, 'invalid attachment context request', async (body) => {
      const trustedRoot = safeTrustedRoot(body.trustedRoot);
      const result = buildAttachmentContext({ files: body.files, trustedRoot, maxSize: body.maxSize });
      sendJson(response, 200, { context: requestContext, ...result });
    });
    return true;
  }

  return false;
}
