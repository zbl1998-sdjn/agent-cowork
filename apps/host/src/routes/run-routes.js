import { listRunRecords, readRunRecord } from '../runtime/run-store.js';
import { formatSseFrame, parseLastEventId } from '../runtime/run-events.js';
import { taskFromRun } from '../runtime/task-presenter.js';
import { decodePathSegment, headerValue, sendJson, stableHeader } from '../http/request-utils.js';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

function recordTenantId(record) {
  return stableHeader(record?.context?.tenantId || record?.tenantId, 'tenant_local');
}

function recordVisibleToContext(record, context) {
  return Boolean(record) && recordTenantId(record) === context.tenantId;
}

function visibleRunRecords(runStoreRoot, context, limit) {
  return listRunRecords(runStoreRoot, { limit: Number.MAX_SAFE_INTEGER })
    .filter((record) => recordVisibleToContext(record, context))
    .slice(0, limit);
}

function parseRunId(pathname, prefix, suffix = '') {
  const encoded = pathname.slice(prefix.length, suffix ? -suffix.length : undefined);
  const runId = decodePathSegment(encoded);
  return RUN_ID_RE.test(runId) ? runId : null;
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
}) {
  if (request.method === 'GET' && pathname === '/api/tasks') {
    const limit = Number(requestUrl.searchParams.get('limit')) || 20;
    const runs = visibleRunRecords(runStoreRoot, requestContext, limit);
    sendJson(response, 200, {
      runStoreRoot,
      tasks: runs.map(taskFromRun),
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runs/index') {
    const limit = Number(requestUrl.searchParams.get('limit')) || 50;
    const status = requestUrl.searchParams.get('status') || undefined;
    const type = requestUrl.searchParams.get('type') || undefined;
    const recipeId = requestUrl.searchParams.get('recipeId') || undefined;
    const userId = requestUrl.searchParams.get('userId') || undefined;
    // await: transparent for the sync file/sqlite adapters, required for the
    // async PostgreSQL adapter (multi-instance backend).
    const records = await runsIndex.list({
      tenantId: requestContext.tenantId,
      userId,
      limit,
      status,
      type,
      recipeId,
    });
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
    let persisted = [];
    try {
      const record = readRunRecord(runStoreRoot, runId);
      if (!recordVisibleToContext(record, requestContext)) {
        sendJson(response, 404, { error: 'Run record not found' });
        return true;
      }
      if (Array.isArray(record.events)) {
        persisted = record.events;
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

    const sentSeqs = new Set();
    const writeEvent = (event) => {
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
    if (heartbeat && typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/runs') {
    const limit = Number(requestUrl.searchParams.get('limit')) || 20;
    sendJson(response, 200, {
      runStoreRoot,
      runs: visibleRunRecords(runStoreRoot, requestContext, limit),
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
