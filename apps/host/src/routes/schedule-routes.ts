// 调度路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/schedules/* —— 创建/列出/暂停/删除计划任务(cron 或定时),交由 L2 调度器执行。
// 依赖:L0 request-utils + L2 scheduler/scheduler-store(经参数注入)。导出:handleScheduleRoutes。
import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';
import {
  canonicalIdentityPart,
  type IdentityScope,
} from '../security/identity-scope.js';
import { omitUndefined } from '../util/object.js';
import {
  emptyBodyFingerprint,
  scheduleCreateBodySchema,
  scheduleOwner,
  scheduleVisibleToContext,
  zodMessage,
} from './schedule-route-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { ScheduleRecipeValidator } from '../runtime/host-scheduler.js';
import type { ScheduleCreateInput, ScheduleRecord, SchedulerFireResult } from '../runtime/scheduler.js';

const SCHEDULE_ID_RE = /^[a-z0-9_-]+$/i;

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = {
  tenantId: string;
  userId?: string;
  traceId?: string;
  idempotencyKey?: string;
  [key: string]: unknown;
};
type SchedulerLike = {
  list(options?: { tenantId?: unknown; userId?: unknown }): ScheduleRecord[];
  create(input: ScheduleCreateInput): ScheduleRecord;
  get(id: string, options?: { tenantId?: unknown; userId?: unknown }): ScheduleRecord | null;
  cancel(id: string, options?: { tenantId?: unknown; userId?: unknown }): boolean;
  remove(id: string, options?: { tenantId?: unknown; userId?: unknown }): boolean;
  tickOnce(filter?: { tenantId?: unknown; userId?: unknown }): Promise<SchedulerFireResult[]>;
};
type ScheduleRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  activeScheduler?: SchedulerLike | null;
  validateRecipeSchedule?: ScheduleRecipeValidator | null;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  safeTrustedRoot(input?: unknown): string;
  workspaceGrantId?: string;
};

export async function handleScheduleRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  activeScheduler,
  validateRecipeSchedule,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
  workspaceGrantId,
}: ScheduleRouteOptions): Promise<boolean> {
  if (pathname !== '/api/schedules' && !pathname.startsWith('/api/schedules/')) {
    return false;
  }
  let owner: IdentityScope;
  try {
    owner = scheduleOwner(requestContext);
  } catch {
    sendJson(response, 401, { error: 'Unauthorized' });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/schedules') {
    const requestedUserId = requestUrl.searchParams.get('userId');
    if (requestedUserId && canonicalIdentityPart(requestedUserId) !== owner.userId) {
      sendJson(response, 403, { error: 'Schedule user scope cannot be overridden' });
      return true;
    }
    const list = activeScheduler ? activeScheduler.list(owner) : [];
    sendJson(response, 200, {
      context: requestContext,
      schedules: list,
      enabled: Boolean(activeScheduler),
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/schedules') {
    await withJsonBody(request, response, async (body) => {
      if (!activeScheduler) {
        sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const parsed = scheduleCreateBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: zodMessage(parsed.error, 'invalid schedule request') });
        return;
      }
      const fingerprint = bodyFingerprint({ body, workspaceGrantId: workspaceGrantId || null });
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const input = parsed.data;
      const payload = { ...input.payload };
      const requestedGrantId = payload.folderGrantId;
      const activeGrantId = typeof workspaceGrantId === 'string' ? workspaceGrantId.trim() : '';
      if (requestedGrantId !== undefined && (typeof requestedGrantId !== 'string' || !requestedGrantId.trim())) {
        sendJson(response, 400, { error: 'payload.folderGrantId must be a non-empty string' });
        return;
      }
      if (requestedGrantId && requestedGrantId !== activeGrantId) {
        sendJson(response, 403, { error: 'schedule folder grant does not match the active workspace grant' });
        return;
      }
      delete payload.folderGrantId;
      if (payload.trustedRoot || activeGrantId) {
        payload.trustedRoot = safeTrustedRoot(payload.trustedRoot);
      }
      if (activeGrantId) payload.folderGrantId = activeGrantId;
      if (validateRecipeSchedule) {
        const validation = validateRecipeSchedule(payload);
        if (!validation.ok) {
          sendJson(response, validation.status, { error: validation.error, code: validation.code });
          return;
        }
        payload.recipeId = validation.recipeId;
      }
      const record = activeScheduler.create(omitUndefined({
        name: input.name,
        cron: input.cron,
        fireAt: input.fireAt,
        payload,
        tenantId: owner.tenantId,
        userId: owner.userId,
        traceId: requestContext.traceId,
        idempotencyKey: requestContext.idempotencyKey,
      }));
      sendCachedOrStore(response, cacheKey, fingerprint, 200, { schedule: record, context: requestContext });
    });
    return true;
  }

  if (request.method === 'POST' && pathname.startsWith('/api/schedules/') && pathname.endsWith('/cancel')) {
    if (!activeScheduler) {
      sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
      return true;
    }
    if (!requireIdempotencyKey(response, requestContext)) {
      return true;
    }
    const fingerprint = emptyBodyFingerprint();
    const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
    if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
      return true;
    }
    const id = decodePathSegment(pathname.slice('/api/schedules/'.length, -'/cancel'.length));
    if (!id || !SCHEDULE_ID_RE.test(id)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 400, { error: 'Invalid schedule id' });
      return true;
    }
    const before = activeScheduler.get(id, owner);
    if (!scheduleVisibleToContext(before, owner)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    const ok = activeScheduler.cancel(id, owner);
    if (!ok) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    sendCachedOrStore(response, cacheKey, fingerprint, 200, { ok: true, schedule: activeScheduler.get(id, owner) });
    return true;
  }

  if (request.method === 'DELETE' && pathname.startsWith('/api/schedules/')) {
    if (!activeScheduler) {
      sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
      return true;
    }
    if (!requireIdempotencyKey(response, requestContext)) {
      return true;
    }
    const fingerprint = emptyBodyFingerprint();
    const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
    if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
      return true;
    }
    const id = decodePathSegment(pathname.slice('/api/schedules/'.length));
    if (!id || !SCHEDULE_ID_RE.test(id)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 400, { error: 'Invalid schedule id' });
      return true;
    }
    const before = activeScheduler.get(id, owner);
    if (!scheduleVisibleToContext(before, owner)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    const ok = activeScheduler.remove(id, owner);
    if (!ok) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    sendCachedOrStore(response, cacheKey, fingerprint, 200, { ok: true });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/schedules/_tick') {
    if (!activeScheduler) {
      sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
      return true;
    }
    if (!requireIdempotencyKey(response, requestContext)) {
      return true;
    }
    const fingerprint = emptyBodyFingerprint();
    const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
    if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
      return true;
    }
    const results = await activeScheduler.tickOnce(owner);
    sendCachedOrStore(response, cacheKey, fingerprint, 200, {
      ok: true,
      fired: results.length,
      results: results.map((r) => ({ ok: r.ok, scheduleId: r.schedule?.id, runId: r.schedule?.lastRunId })),
    });
    return true;
  }

  return false;
}
