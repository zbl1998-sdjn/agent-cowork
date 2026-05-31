// 调度路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/schedules/* —— 创建/列出/暂停/删除计划任务(cron 或定时),交由 L2 调度器执行。
// 依赖:L0 request-utils + L2 scheduler/scheduler-store(经参数注入)。导出:handleScheduleRoutes。
import { z } from 'zod';
import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  stableHeader,
  withJsonBody,
} from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
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
  get(id: string): ScheduleRecord | null;
  cancel(id: string): boolean;
  remove(id: string): boolean;
  tickOnce(filter?: { tenantId?: unknown; userId?: unknown }): Promise<SchedulerFireResult[]>;
};
type ScheduleRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  activeScheduler?: SchedulerLike | null;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  safeTrustedRoot(input?: unknown): string;
};

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const stringOrNullSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().nullable().optional(),
);
const payloadSchema = z.preprocess(
  (value) => (value == null ? {} : value),
  z.object({}).passthrough(),
);
const scheduleCreateBodySchema = z.preprocess(objectBody, z.object({
  name: z.string().trim().min(1, 'name is required'),
  cron: stringOrNullSchema,
  fireAt: stringOrNullSchema,
  payload: payloadSchema,
}).passthrough());

function scheduleVisibleToContext(record: ScheduleRecord | null | undefined, context: RequestContext): boolean {
  return Boolean(record) && stableHeader(record?.tenantId, 'tenant_local') === context.tenantId;
}

function emptyBodyFingerprint(): string {
  return bodyFingerprint({});
}

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export async function handleScheduleRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  activeScheduler,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
}: ScheduleRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/schedules') {
    const userId = requestUrl.searchParams.get('userId') || undefined;
    const list = activeScheduler ? activeScheduler.list({
      tenantId: requestContext.tenantId,
      userId,
    }) : [];
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
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const input = parsed.data;
      const payload = { ...input.payload };
      if (payload.trustedRoot) {
        payload.trustedRoot = safeTrustedRoot(payload.trustedRoot);
      }
      const record = activeScheduler.create({
        name: input.name,
        cron: input.cron,
        fireAt: input.fireAt,
        payload,
        tenantId: requestContext.tenantId,
        userId: requestContext.userId,
        traceId: requestContext.traceId,
        idempotencyKey: requestContext.idempotencyKey,
      });
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
    const before = activeScheduler.get(id);
    if (!scheduleVisibleToContext(before, requestContext)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    const ok = activeScheduler.cancel(id);
    if (!ok) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    sendCachedOrStore(response, cacheKey, fingerprint, 200, { ok: true, schedule: activeScheduler.get(id) });
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
    const before = activeScheduler.get(id);
    if (!scheduleVisibleToContext(before, requestContext)) {
      sendCachedOrStore(response, cacheKey, fingerprint, 404, { error: 'Schedule not found' });
      return true;
    }
    const ok = activeScheduler.remove(id);
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
    const results = await activeScheduler.tickOnce({ tenantId: requestContext.tenantId });
    sendCachedOrStore(response, cacheKey, fingerprint, 200, {
      ok: true,
      fired: results.length,
      results: results.map((r) => ({ ok: r.ok, scheduleId: r.schedule?.id, runId: r.schedule?.lastRunId })),
    });
    return true;
  }

  return false;
}
