// 工作区文件操作路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:预览/执行/回滚批量文件操作,统一走审批与幂等缓存。
// 依赖:L0 request-utils + L1 workspace/file-operations + L2 file-operation-approvals(经参数注入)。
import { z } from 'zod';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import {
  previewFileOperations,
  applyFileOperations,
  rollbackFileOperations,
} from '../workspace/file-operations.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = Record<string, unknown>;
type JournalWriter = { append(event: unknown): unknown };
type FileOperationBody = { trustedRoot?: unknown; [key: string]: unknown };
type FileOperationApprovals = {
  issue(input: unknown): string;
  consume(id: unknown, input: unknown): unknown;
};
type WorkspaceFileOperationRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  config: { journalWriter?: JournalWriter };
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  safeTrustedRoot(input?: unknown): string;
  fileOperationApprovals: FileOperationApprovals;
};

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const safeIdPattern = /^[a-zA-Z0-9_.:-]{1,128}$/;
const approvalIdSchema = z.string().trim().regex(safeIdPattern, 'approval id is invalid').optional();
const fileOperationSchema = z.object({
  type: z.unknown(),
  path: z.unknown().optional(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  newName: z.unknown().optional(),
  content: z.unknown().optional(),
  contentBase64: z.unknown().optional(),
  encoding: z.unknown().optional(),
  overwrite: z.unknown().optional(),
}).passthrough().superRefine((operation, ctx) => {
  const type = typeof operation.type === 'string' ? operation.type.toLowerCase() : '';
  if (!['write', 'rename', 'move', 'delete'].includes(type)) {
    ctx.addIssue({ code: 'custom', path: ['type'], message: 'operation type must be write, rename, move, or delete' });
    return;
  }
  if (operation.contentBase64 !== undefined && typeof operation.contentBase64 !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['contentBase64'], message: 'contentBase64 must be a string' });
  }
  if (operation.encoding !== undefined && typeof operation.encoding !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['encoding'], message: 'encoding must be a string' });
  }
  if (operation.overwrite !== undefined && typeof operation.overwrite !== 'boolean') {
    ctx.addIssue({ code: 'custom', path: ['overwrite'], message: 'overwrite must be a boolean' });
  }
  if ((type === 'write' || type === 'rename') && (typeof operation.path !== 'string' || !operation.path.trim())) {
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'operation path is required' });
  }
  if (type === 'rename' && (typeof operation.newName !== 'string' || !operation.newName.trim())) {
    ctx.addIssue({ code: 'custom', path: ['newName'], message: 'operation newName is required' });
  }
  if (type === 'move') {
    if (typeof operation.from !== 'string' || !operation.from.trim()) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: 'operation from is required' });
    }
    if (typeof operation.to !== 'string' || !operation.to.trim()) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'operation to is required' });
    }
  }
});
const rollbackEntrySchema = z.object({}).passthrough();
const baseBodySchema = z.preprocess(
  objectBody,
  z.object({ trustedRoot: z.unknown().optional() }).passthrough(),
);
const operationsBodySchema = baseBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  operations: z.array(fileOperationSchema, 'operations must be an array'),
}).passthrough());
const applyBodySchema = operationsBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  operations: z.array(fileOperationSchema, 'operations must be an array'),
  fileOperationApprovalId: approvalIdSchema,
  approvalId: approvalIdSchema,
}).passthrough());
const rollbackBodySchema = baseBodySchema.pipe(z.object({
  trustedRoot: z.unknown().optional(),
  operations: z.array(rollbackEntrySchema, 'operations must be an array').optional(),
  rollback: z.array(rollbackEntrySchema, 'rollback must be an array').optional(),
  applied: z.array(rollbackEntrySchema, 'applied must be an array').optional(),
  rollbackApprovalId: approvalIdSchema,
  fileOperationApprovalId: approvalIdSchema,
  approvalId: approvalIdSchema,
}).passthrough().superRefine((input, ctx) => {
  if (!input.rollback && !input.applied && !input.operations) {
    ctx.addIssue({
      code: 'custom',
      path: ['operations'],
      message: 'rollback, applied, or operations must be an array',
    });
  }
}));

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || fallback;
  return err instanceof Error ? err.message : String(err);
}

async function withParsedFileOpsBody<S extends z.ZodType>(
  request: RouteRequest,
  response: HttpResponseLike,
  schema: S,
  handler: (body: z.output<S>) => void | Promise<void>,
): Promise<void> {
  await withJsonBody(request, response, async (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: errorMessage(parsed.error, 'invalid file operation request') });
      return;
    }
    await handler(parsed.data);
  });
}

function cachedWrite(
  options: WorkspaceFileOperationRouteOptions,
  body: FileOperationBody,
  handler: () => unknown,
): void {
  const { request, response, pathname, requestContext, cacheKeyFor, requireIdempotencyKey, sendCachedOrStore } = options;
  if (!requireIdempotencyKey(response, requestContext)) return;
  const fingerprint = bodyFingerprint(body);
  const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
  if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
  const payload = handler();
  sendCachedOrStore(response, cacheKey, fingerprint, 200, payload);
}

export async function handleWorkspaceFileOperationRoutes(options: WorkspaceFileOperationRouteOptions): Promise<boolean> {
  const {
    request,
    response,
    pathname,
    requestContext,
    config,
    safeTrustedRoot,
    fileOperationApprovals,
  } = options;

  if (request.method === 'POST' && pathname === '/api/file-ops/preview') {
    await withParsedFileOpsBody(request, response, operationsBodySchema, async (body) => {
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
    await withParsedFileOpsBody(request, response, applyBodySchema, async (body) => {
      cachedWrite(options, body, () => {
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
        return {
          ...applied,
          rollbackApprovalId,
          context: requestContext,
        };
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/file-ops/rollback') {
    await withParsedFileOpsBody(request, response, rollbackBodySchema, async (body) => {
      cachedWrite(options, body, () => {
        const trustedRoot = safeTrustedRoot(body.trustedRoot);
        const entries = body.rollback ?? body.applied ?? body.operations;
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
        return {
          ...rollback,
          context: requestContext,
        };
      });
    });
    return true;
  }

  return false;
}
