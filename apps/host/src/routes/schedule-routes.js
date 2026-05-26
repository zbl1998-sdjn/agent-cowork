import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  stableHeader,
  withJsonBody,
} from '../http/request-utils.js';

const SCHEDULE_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../runtime/scheduler.js').ScheduleRecord} ScheduleRecord
 * @typedef {import('../runtime/scheduler.js').SchedulerFireResult} SchedulerFireResult
 * @typedef {{ tenantId: string, userId?: string, traceId?: string, idempotencyKey?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ payload?: unknown, name?: unknown, cron?: unknown, fireAt?: unknown }} ScheduleBody
 * @typedef {{ list(options?: { tenantId?: unknown, userId?: unknown }): ScheduleRecord[], create(input: unknown): ScheduleRecord, get(id: string): ScheduleRecord | null, cancel(id: string): boolean, remove(id: string): boolean, tickOnce(filter?: { tenantId?: unknown, userId?: unknown }): Promise<SchedulerFireResult[]> }} SchedulerLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, activeScheduler?: SchedulerLike | null, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string }} ScheduleRouteOptions
 */

/** @param {ScheduleRecord | null | undefined} record @param {RequestContext} context @returns {boolean} */
function scheduleVisibleToContext(record, context) {
  return Boolean(record) && stableHeader(record?.tenantId, 'tenant_local') === context.tenantId;
}

/** @returns {string} */
function emptyBodyFingerprint() {
  return bodyFingerprint({});
}

/** @param {ScheduleRouteOptions} options @returns {Promise<boolean>} */
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
}) {
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
      const input = /** @type {ScheduleBody} */ (body || {});
      if (!activeScheduler) {
        sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const payload = /** @type {Record<string, unknown>} */ (
        input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
          ? { ...input.payload }
          : {}
      );
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
