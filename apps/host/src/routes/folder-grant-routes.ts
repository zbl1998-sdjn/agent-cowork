// Connected-folder grant HTTP contract (host · L3 routes).
// GET lists owner-scoped active/tombstoned grants; POST registers a canonical
// in-jail directory; DELETE writes a revocation tombstone. Writes are idempotent.
import { z } from 'zod';

import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  withJsonBody,
  type HttpRequestLike,
  type HttpResponseLike,
  type RequestContext,
} from '../http/request-utils.js';
import type { FolderGrantRegistry } from '../runtime/folder-grants.js';
import type { FolderGrantRecord } from '../workspace/folder-grant-records.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  folderGrants: FolderGrantRegistry;
  cacheKeyFor(context: RequestContext, method: string, pathname: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string,
    status: number,
    payload?: unknown,
  ): boolean;
};

const createBodySchema = z.object({
  path: z.string().min(1).max(32_768),
  displayName: z.string().min(1).max(256).optional(),
  source: z.enum(['picker', 'manual']).optional(),
  idempotencyKey: z.string().optional(),
}).strict();
const revokeBodySchema = z.object({ idempotencyKey: z.string().optional() }).strict();

function statusOf(error: unknown, fallback: number): number {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  return typeof statusCode === 'number' ? statusCode : fallback;
}

function messageOf(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message || 'invalid folder grant request';
  return error instanceof Error ? error.message : 'folder grant request failed';
}

function grantDto(grant: FolderGrantRecord): Record<string, unknown> {
  return {
    id: grant.id,
    path: grant.path,
    displayName: grant.displayName,
    source: grant.source,
    status: grant.revokedAt === null ? 'active' : 'revoked',
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
    revokedAt: grant.revokedAt,
    supersedesGrantId: grant.supersedesGrantId,
  };
}

export async function handleFolderGrantRoutes(options: RouteOptions): Promise<boolean> {
  const { request, response, pathname, requestUrl, requestContext, folderGrants } = options;
  if (!pathname.startsWith('/api/folder-grants')) return false;

  if (request.method === 'GET' && pathname === '/api/folder-grants') {
    try {
      const includeRevoked = requestUrl.searchParams.get('includeRevoked') === '1';
      const grants = folderGrants.list(requestContext, { includeRevoked }).map(grantDto);
      sendJson(response, 200, { grants });
    } catch (error) {
      sendJson(response, statusOf(error, 500), { error: messageOf(error) });
    }
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/folder-grants') {
    await withJsonBody(request, response, async (body) => {
      if (!options.requireIdempotencyKey(response, requestContext)) return;
      const input = createBodySchema.parse(body);
      const fingerprint = bodyFingerprint(input);
      const cacheKey = options.cacheKeyFor(requestContext, request.method || 'POST', pathname);
      if (options.sendCachedOrStore(response, cacheKey, fingerprint, 201)) return;
      const grant = folderGrants.create(requestContext, {
        path: input.path,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
      });
      options.sendCachedOrStore(response, cacheKey, fingerprint, 201, { grant: grantDto(grant) });
    });
    return true;
  }

  const match = /^\/api\/folder-grants\/([^/]+)$/.exec(pathname);
  if (!match || request.method !== 'DELETE') return false;
  const grantId = decodePathSegment(match[1]);
  if (!grantId) {
    sendJson(response, 400, { error: 'invalid folder grant id' });
    return true;
  }
  await withJsonBody(request, response, async (body) => {
    if (!options.requireIdempotencyKey(response, requestContext)) return;
    const input = revokeBodySchema.parse(body);
    const fingerprint = bodyFingerprint({ ...input, grantId });
    const cacheKey = options.cacheKeyFor(requestContext, request.method || 'DELETE', pathname);
    if (options.sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
    const grant = folderGrants.revoke(requestContext, grantId);
    if (!grant) {
      const error = new Error('folder grant not found') as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    options.sendCachedOrStore(response, cacheKey, fingerprint, 200, { grant: grantDto(grant) });
  });
  return true;
}
