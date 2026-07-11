// 运行历史路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/runs/* —— 列出运行历史(经索引)、读取单条 run 记录与事件时间线/trace,供历史与回放 UI。
// 依赖:L2 run-store / runs-index(经参数注入)。导出:handleRunRoutes。
import { readRunRecord } from '../runtime/run-store.js';
import { formatSseFrame, parseLastEventId } from '../runtime/run-events.js';
import { headerValue, sendJson } from '../http/request-utils.js';
import { requireIdentityScopeFrom, type IdentityScope } from '../security/identity-scope.js';
import { AtRestKeyError } from '../security/at-rest.js';
import { omitUndefined } from '../util/object.js';
import {
  parseRunQuery,
  runIndexQuerySchema,
  runListQuerySchema,
  taskListQuerySchema,
} from './run-route-schemas.js';
import {
  parseRunId,
  presentRunTask,
  recordVisibleToContext,
  visibleRunRecords,
} from './run-route-visibility.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { RunEvent } from '../runtime/run-events.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteResponse = HttpResponseLike & {
  write(chunk?: string | Buffer): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
};
type RequestContext = { tenantId: string; userId?: string; traceId: string; [key: string]: unknown };
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
  stats(options?: { tenantId?: string; userId?: string }): unknown | Promise<unknown>;
};
type RunEventsLike = {
  seed(runId: string, events: RunEvent[], scope?: RequestContext): unknown;
  replay(runId: string, afterSeq?: number, scope?: RequestContext): RunEvent[];
  subscribe(runId: string, listener: (event: RunEvent) => void, scope?: RequestContext): () => void;
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
  const isRunRoute = pathname === '/api/tasks'
    || pathname === '/api/runs'
    || pathname.startsWith('/api/runs/');
  if (!isRunRoute) return false;

  let requestOwner: IdentityScope;
  try {
    requestOwner = requireIdentityScopeFrom(requestContext, { label: 'run route identity' });
  } catch {
    sendJson(response, 401, { error: 'Unauthorized' });
    return true;
  }
  const scopedContext: RequestContext = {
    ...requestContext,
    tenantId: requestOwner.tenantId,
    userId: requestOwner.userId,
  };

  if (request.method === 'GET' && pathname === '/api/tasks') {
    const query = parseRunQuery(response, taskListQuerySchema, {
      limit: requestUrl.searchParams.get('limit'),
    }, 'invalid task list query');
    if (!query) return true;
    const runs = visibleRunRecords(runStoreRoot, requestOwner, query.limit);
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
    }, 'invalid run index query');
    if (!query) return true;
    // await: transparent for the sync file/sqlite adapters, required for the
    // async PostgreSQL adapter (multi-instance backend).
    const records = await runsIndex.list(omitUndefined({
      tenantId: requestOwner.tenantId,
      userId: requestOwner.userId,
      limit: query.limit,
      status: query.status,
      type: query.type,
      recipeId: query.recipeId,
    }));
    const stats = await runsIndex.stats({
      tenantId: requestOwner.tenantId,
      userId: requestOwner.userId,
    });
    sendJson(response, 200, {
      context: scopedContext,
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
      if (!record || !recordVisibleToContext(record, requestOwner)) {
        sendJson(response, 404, { error: 'Run record not found' });
        return true;
      }
      if (Array.isArray(record.events)) {
        persisted = record.events as RunEvent[];
      }
    } catch (error) {
      if (error instanceof AtRestKeyError) {
        sendJson(response, error.statusCode, { error: error.message, code: error.code });
        return true;
      }
      sendJson(response, 404, { error: 'Run record not found' });
      return true;
    }
    runEvents.seed(runId, persisted, scopedContext);

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-trace-id': scopedContext.traceId,
      'x-tenant-id': requestOwner.tenantId,
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
    for (const event of runEvents.replay(runId, lastEventId, scopedContext)) {
      writeEvent(event);
    }

    const unsubscribe = runEvents.subscribe(runId, (event) => {
      writeEvent(event);
    }, scopedContext);
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
      runs: visibleRunRecords(runStoreRoot, requestOwner, query.limit),
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
    if (!recordVisibleToContext(run, requestOwner)) {
      sendJson(response, 404, { error: 'Run record not found' });
      return true;
    }
    sendJson(response, 200, run);
    return true;
  }

  return false;
}
