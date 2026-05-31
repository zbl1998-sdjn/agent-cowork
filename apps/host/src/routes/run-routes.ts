// 运行历史路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/runs/* —— 列出运行历史(经索引)、读取单条 run 记录与事件时间线/trace,供历史与回放 UI。
// 依赖:L2 run-store / runs-index(经参数注入)。导出:handleRunRoutes。
import { listRunRecords, readRunRecord } from '../runtime/run-store.js';
import { formatSseFrame, parseLastEventId } from '../runtime/run-events.js';
import { taskFromRun } from '../runtime/task-presenter.js';
import { decodePathSegment, headerValue, sendJson, stableHeader } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import {
  parseRunQuery,
  runIndexQuerySchema,
  runListQuerySchema,
  taskListQuerySchema,
} from './run-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { RunRecord, RunSummary } from '../runtime/run-store.js';
import type { RunEvent } from '../runtime/run-events.js';
import type { RunSummary as PresenterRunSummary, TaskSummary } from '../runtime/task-presenter.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

type RouteRequest = HttpRequestLike & { method?: string };
type RouteResponse = HttpResponseLike & {
  write(chunk?: string | Buffer): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};
type RequestContext = { tenantId: string; userId?: string; traceId: string; [key: string]: unknown };
type VisibleRunRecord = RunRecord | RunSummary;
type RunsIndexListOptions = {
  tenantId?: string;
  userId?: string;
  limit?: number;
  status?: string;
  type?: string;
  recipeId?: string;
};
type RunsIndexLike = {
  list(options?: RunsIndexListOptions): unknown[] | Promise<unknown[]>;
  stats(options?: { tenantId?: string }): unknown | Promise<unknown>;
};
type RunEventsLike = {
  seed(runId: string, events: RunEvent[]): unknown;
  replay(runId: string, afterSeq?: number): RunEvent[];
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void;
};
type RunRouteOptions = {
  request: RouteRequest;
  response: RouteResponse;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  runEvents: RunEventsLike;
};

function recordTenantId(record: VisibleRunRecord | null | undefined): string {
  return stableHeader(record?.context?.tenantId || record?.tenantId, 'tenant_local');
}

function recordVisibleToContext(record: VisibleRunRecord | null | undefined, context: RequestContext): boolean {
  return Boolean(record) && recordTenantId(record) === context.tenantId;
}

function visibleRunRecords(runStoreRoot: string, context: RequestContext, limit: number): RunSummary[] {
  return listRunRecords(runStoreRoot, { limit: Number.MAX_SAFE_INTEGER })
    .filter((record) => recordVisibleToContext(record, context))
    .slice(0, limit);
}

function parseRunId(pathname: string, prefix: string, suffix = ''): string | null {
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const runId = decodePathSegment(encoded);
  return runId && RUN_ID_RE.test(runId) ? runId : null;
}

function presentRunTask(run: RunSummary): TaskSummary {
  return taskFromRun(run as unknown as PresenterRunSummary);
}

export async function handleRunRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  runStoreRoot,
  runsIndex,
  runEvents,
}: RunRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/tasks') {
    const query = parseRunQuery(response, taskListQuerySchema, {
      limit: requestUrl.searchParams.get('limit'),
    }, 'invalid task list query');
    if (!query) return true;
    const runs = visibleRunRecords(runStoreRoot, requestContext, query.limit);
    sendJson(response, 200, {
      runStoreRoot,
      tasks: runs.map(presentRunTask),
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runs/index') {
    const query = parseRunQuery(response, runIndexQuerySchema, {
      limit: requestUrl.searchParams.get('limit'),
      status: requestUrl.searchParams.get('status'),
      type: requestUrl.searchParams.get('type'),
      recipeId: requestUrl.searchParams.get('recipeId'),
      userId: requestUrl.searchParams.get('userId'),
    }, 'invalid run index query');
    if (!query) return true;
    // await: transparent for the sync file/sqlite adapters, required for the
    // async PostgreSQL adapter (multi-instance backend).
    const records = await runsIndex.list(omitUndefined({
      tenantId: requestContext.tenantId,
      userId: query.userId,
      limit: query.limit,
      status: query.status,
      type: query.type,
      recipeId: query.recipeId,
    }));
    const stats = await runsIndex.stats({ tenantId: requestContext.tenantId });
    sendJson(response, 200, {
      context: requestContext,
      stats,
      runs: records,
    });
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/events')) {
    const runId = parseRunId(pathname, '/api/runs/', '/events');
    if (!runId) {
      sendJson(response, 400, { error: 'Invalid run id' });
      return true;
    }
    const lastEventId = parseLastEventId(
      headerValue(request, 'last-event-id') || requestUrl.searchParams.get('lastEventId'),
    );
    let persisted: RunEvent[] = [];
    try {
      const record = readRunRecord(runStoreRoot, runId);
      if (!record || !recordVisibleToContext(record, requestContext)) {
        sendJson(response, 404, { error: 'Run record not found' });
        return true;
      }
      if (Array.isArray(record.events)) {
        persisted = record.events as RunEvent[];
      }
    } catch {
      sendJson(response, 404, { error: 'Run record not found' });
      return true;
    }
    runEvents.seed(runId, persisted);

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-trace-id': requestContext.traceId,
      'x-tenant-id': requestContext.tenantId,
    });
    response.write('retry: 3000\n\n');

    const sentSeqs = new Set<unknown>();
    const writeEvent = (event: RunEvent): void => {
      if (event.seq != null) {
        if (sentSeqs.has(event.seq)) {
          return;
        }
        sentSeqs.add(event.seq);
      }
      response.write(formatSseFrame(event));
    };

    for (const event of persisted) {
      if ((Number(event.seq) || 0) > lastEventId) {
        writeEvent(event);
      }
    }
    for (const event of runEvents.replay(runId, lastEventId)) {
      writeEvent(event);
    }

    const unsubscribe = runEvents.subscribe(runId, (event) => {
      writeEvent(event);
    });
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, 15000);
    const maybeUnref = heartbeat as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') {
      maybeUnref.unref();
    }
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runs') {
    const query = parseRunQuery(response, runListQuerySchema, {
      limit: requestUrl.searchParams.get('limit'),
    }, 'invalid run list query');
    if (!query) return true;
    sendJson(response, 200, {
      runStoreRoot,
      runs: visibleRunRecords(runStoreRoot, requestContext, query.limit),
    });
    return true;
  }

  if (request.method === 'GET' && pathname.startsWith('/api/runs/')) {
    const runId = parseRunId(pathname, '/api/runs/');
    if (!runId) {
      sendJson(response, 400, { error: 'Invalid run id' });
      return true;
    }
    const run = readRunRecord(runStoreRoot, runId);
    if (!recordVisibleToContext(run, requestContext)) {
      sendJson(response, 404, { error: 'Run record not found' });
      return true;
    }
    sendJson(response, 200, run);
    return true;
  }

  return false;
}
