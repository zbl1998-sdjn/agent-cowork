// ONLYOFFICE Document Server 路由(host · L3 routes)
// ---------------------------------------------------------------------------
// 职责:审批会话、签名编辑页、受限源文件下载、JWT 回调与保存状态；文件语义委托 L1 artifacts。
import { z } from 'zod';

import {
  buildArtifactEditorExternalCopyPlan,
  inspectArtifactEditorExternalCopy,
  publishArtifactEditorExternalCopy,
  readArtifactEditorExternalSource,
  type ArtifactEditorExternalCopyPlan,
} from '../artifacts/artifact-editor-service.js';
import type { OnlyOfficeConfig } from '../artifacts/onlyoffice-config.js';
import { createOnlyOfficeEditorPage } from '../artifacts/onlyoffice-editor-page.js';
import {
  createOnlyOfficeSessionToken,
  verifyOnlyOfficeSessionToken,
  type OnlyOfficeSessionClaims,
} from '../artifacts/onlyoffice-session.js';
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike, RequestContext } from '../http/request-utils.js';
import type { FileOperationApprovalStore } from '../runtime/file-operation-approvals.js';
import { fetchOnlyOfficeFile, probeOnlyOffice, verifyOnlyOfficeCallback } from './onlyoffice-route-support.js';

const APPROVAL_KIND = 'artifact:start-onlyoffice-copy';
const sessionSchema = z.object({
  trustedRoot: z.unknown().optional(),
  path: z.string().min(1, 'artifact path is required'),
  copyName: z.string().trim().min(1).max(180),
  fileOperationApprovalId: z.string().max(160).optional(),
}).loose();

type RouteRequest = HttpRequestLike & { method?: string };
type OnlyOfficeRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  trustedRootDefault?: string;
  safeTrustedRoot(input?: unknown): string;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  fileOperationApprovals: Pick<FileOperationApprovalStore, 'issue' | 'consume'>;
  config: OnlyOfficeConfig;
  fetchImpl: typeof fetch;
};

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function requireConfigured(config: OnlyOfficeConfig): void {
  if (!config.enabled) throw httpError(503, 'ONLYOFFICE integration is disabled');
  if (!config.configured) throw httpError(503, `ONLYOFFICE configuration is incomplete: ${config.missing.join(', ')}`);
}

function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function contextFrom(claims: OnlyOfficeSessionClaims): RequestContext {
  return {
    tenantId: claims.tenantId,
    userId: claims.userId,
    traceId: `onlyoffice_${claims.jti}`,
    authenticated: true,
    idempotencyKey: '',
  };
}

function planFromClaims(claims: OnlyOfficeSessionClaims): ArtifactEditorExternalCopyPlan {
  const plan = buildArtifactEditorExternalCopyPlan({
    trustedRoot: claims.trustedRoot,
    artifactPath: claims.sourcePath,
    copyName: claims.copyName,
    context: contextFrom(claims),
    allowExisting: true,
  });
  if (
    plan.sourcePath !== claims.sourcePath
    || plan.targetPath !== claims.targetPath
    || plan.sourceRevisionSha256 !== claims.sourceRevisionSha256
  ) throw httpError(409, 'ONLYOFFICE session no longer matches the artifact');
  return plan;
}

function sessionClaims(options: OnlyOfficeRouteOptions): OnlyOfficeSessionClaims {
  requireConfigured(options.config);
  const token = options.requestUrl.searchParams.get('session');
  if (!token) throw httpError(403, 'ONLYOFFICE session token is required');
  try { return verifyOnlyOfficeSessionToken(token, options.config.jwtSecret); }
  catch (error) { throw httpError(403, (error as Error).message); }
}

async function handleCallback(options: OnlyOfficeRouteOptions, body: unknown): Promise<void> {
  const claims = sessionClaims(options);
  const payload = verifyOnlyOfficeCallback({ request: options.request, config: options.config, body });
  if (payload.key !== claims.documentKey) throw httpError(403, 'ONLYOFFICE callback document key is invalid');
  const status = Number(payload.status);
  if (![1, 2, 3, 4, 6, 7].includes(status)) throw httpError(400, 'ONLYOFFICE callback status is invalid');
  if (status !== 2) {
    if (status === 3 || status === 7) console.warn(`[onlyoffice] Document Server reported save status ${status} for ${claims.documentKey}`);
    sendJson(options.response, 200, { error: 0 });
    return;
  }
  try {
    if (typeof payload.url !== 'string' || !payload.url) throw new Error('ONLYOFFICE callback save URL is missing');
    const plan = planFromClaims(claims);
    const output = await fetchOnlyOfficeFile(payload.url, options);
    publishArtifactEditorExternalCopy({ trustedRoot: claims.trustedRoot, context: contextFrom(claims) }, plan, output);
    sendJson(options.response, 200, { error: 0 });
  } catch (error) {
    console.error(`[onlyoffice] callback save failed for ${claims.documentKey}: ${(error as Error).message}`);
    sendJson(options.response, 200, { error: 1 });
  }
}

export async function handleOnlyOfficeRoutes(options: OnlyOfficeRouteOptions): Promise<boolean> {
  const { request, response, pathname, requestContext } = options;
  if (request.method === 'GET' && pathname === '/api/artifacts/onlyoffice/status') {
    const probe = await probeOnlyOffice(options);
    sendJson(response, 200, { enabled: options.config.enabled, configured: options.config.configured, ...probe, missing: options.config.missing });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/artifacts/onlyoffice/content') {
    const claims = sessionClaims(options);
    const source = readArtifactEditorExternalSource({
      trustedRoot: claims.trustedRoot,
      sourcePath: claims.sourcePath,
      sourceRevisionSha256: claims.sourceRevisionSha256,
      context: contextFrom(claims),
    });
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': source.content.length,
      'cache-control': 'private, no-store',
      'content-disposition': contentDisposition(source.name),
    });
    response.end(source.content);
    return true;
  }
  if (request.method === 'GET' && pathname === '/onlyoffice-editor.html') {
    const claims = sessionClaims(options);
    planFromClaims(claims);
    const sessionToken = options.requestUrl.searchParams.get('session') || '';
    const page = createOnlyOfficeEditorPage({ config: options.config, sessionToken, claims });
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': page.contentSecurityPolicy,
      'referrer-policy': 'no-referrer',
    });
    response.end(page.html);
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/artifacts/onlyoffice/callback') {
    requireConfigured(options.config);
    await withJsonBody(request, response, (body) => handleCallback(options, body), { maxBytes: 2 * 1024 * 1024 });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/artifacts/onlyoffice/session/status') {
    const claims = sessionClaims(options);
    if (claims.tenantId !== requestContext.tenantId || claims.userId !== requestContext.userId) throw httpError(403, 'ONLYOFFICE session owner is invalid');
    const plan = planFromClaims(claims);
    const result = inspectArtifactEditorExternalCopy({ trustedRoot: claims.trustedRoot, context: requestContext }, plan);
    sendJson(response, 200, { ...result, path: plan.targetPath, name: plan.copyName });
    return true;
  }
  const isPreview = request.method === 'POST' && pathname === '/api/artifacts/onlyoffice/session/preview';
  const isStart = request.method === 'POST' && pathname === '/api/artifacts/onlyoffice/session';
  if (!isPreview && !isStart) return false;
  requireConfigured(options.config);
  await withJsonBody(request, response, async (body) => {
    const parsed = sessionSchema.safeParse(body);
    if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message || 'invalid ONLYOFFICE session request');
    if (isStart && !options.requireIdempotencyKey(response, requestContext)) return;
    const trustedRoot = options.safeTrustedRoot(parsed.data.trustedRoot || options.trustedRootDefault);
    const plan = buildArtifactEditorExternalCopyPlan({
      trustedRoot,
      artifactPath: parsed.data.path,
      copyName: parsed.data.copyName,
      context: requestContext,
    });
    if (isPreview) {
      const fileOperationApprovalId = options.fileOperationApprovals.issue({
        kind: APPROVAL_KIND, trustedRoot, operations: plan.operations, context: requestContext,
      });
      sendJson(response, 200, { path: plan.targetPath, name: plan.copyName, fileOperationApprovalId });
      return;
    }
    const cacheKey = options.cacheKeyFor(requestContext, request.method, pathname);
    const fingerprint = bodyFingerprint({ body, trustedRoot });
    if (options.sendCachedOrStore(response, cacheKey, fingerprint, 201)) return;
    options.fileOperationApprovals.consume(parsed.data.fileOperationApprovalId, {
      kind: APPROVAL_KIND, trustedRoot, operations: plan.operations, context: requestContext,
    });
    const session = createOnlyOfficeSessionToken({
      secret: options.config.jwtSecret,
      ttlMs: options.config.sessionTtlMs,
      trustedRoot,
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      copyName: plan.copyName,
      sourceRevisionSha256: plan.sourceRevisionSha256,
      tenantId: requestContext.tenantId,
      userId: requestContext.userId,
    });
    const editorPath = `/onlyoffice-editor.html?session=${encodeURIComponent(session.token)}`;
    options.sendCachedOrStore(response, cacheKey, fingerprint, 201, {
      path: plan.targetPath,
      name: plan.copyName,
      documentKey: session.claims.documentKey,
      expiresAt: new Date(session.claims.exp * 1000).toISOString(),
      editorPath,
    });
  });
  return true;
}
