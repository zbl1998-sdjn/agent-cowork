// Orchestrator 路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/orchestrator/* 的 P0 同步编排入口。这里只做 HTTP 入参校验、run record 持久化和回读;
//       实际状态机、上下文裁剪、预算和 trace 仍由 L2 orchestrator runtime 承担。
import {
  createDefaultAgentRegistry,
  createOrchestrationCheckpointStore,
} from '../orchestrator/index.js';
import {
  bodyFingerprint,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';
import {
  orchestratorDetailPayload,
  parseOrchestratorRunId,
  routeContext,
  runOrchestration,
  resumeOrchestration,
  startOrchestrationSchema,
} from './orchestrator-route-support.js';
import { orchestratorOwner, readOwnedOrchestratorRecord } from './orchestrator-owner-guard.js';
import { startAsyncOrchestration } from './orchestrator-async-support.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { OrchestrationRun } from '../orchestrator/index.js';
import type { ReadOnlyToolRegistryLike } from '../orchestrator/subagent-task-runner.js';
import type { RunEventsLike } from '../runtime/subagent.js';
import type {
  OrchestratorCancellationLike,
  OrchestratorRequestContext,
  ProviderModelCall,
  RunOrchestrationOptions,
  RunsIndexLike,
} from './orchestrator-route-support.js';

type RouteRequest = HttpRequestLike & { method?: string };
export type OrchestratorRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: OrchestratorRequestContext;
  runStoreRoot: string;
  runsIndex?: RunsIndexLike | null;
  runEvents?: RunEventsLike | null;
  toolRegistry?: ReadOnlyToolRegistryLike | null;
  modelConfig?: RunOrchestrationOptions['modelConfig'];
  modelCall?: ProviderModelCall;
  fetchImpl?: unknown;
  cancellation?: OrchestratorCancellationLike | null;
  fileSummaryCache?: RunOrchestrationOptions['fileSummaryCache'];
  cacheKeyFor(context: OrchestratorRequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: OrchestratorRequestContext): boolean;
  sendCachedOrStore(
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string,
    status: number,
    payload?: unknown,
  ): unknown;
  safeTrustedRoot(input?: unknown): string;
};

function agentSummaries(run: OrchestrationRun): Array<{ id: string; displayName: string }> {
  const registry = createDefaultAgentRegistry();
  return run.agents.map((id) => ({ id, displayName: registry.get(id).displayName }));
}

async function handleStart(options: OrchestratorRouteOptions): Promise<void> {
  const { request, response, pathname, requestContext } = options;
  await withJsonBody(request, response, async (body) => {
    if (!options.requireIdempotencyKey(response, requestContext)) return;
    const parsed = startOrchestrationSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid orchestrator request' });
      return;
    }
    const fingerprint = bodyFingerprint(body);
    const cacheKey = options.cacheKeyFor(requestContext, request.method, pathname);
    if (options.sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
    const runOptions: Parameters<typeof runOrchestration>[1] = {
      requestContext,
      runStoreRoot: options.runStoreRoot,
      safeTrustedRoot: options.safeTrustedRoot,
      runEvents: options.runEvents || null,
      toolRegistry: options.toolRegistry || null,
      modelConfig: options.modelConfig || null,
      modelCall: options.modelCall,
      fetchImpl: options.fetchImpl,
      cancellation: options.cancellation || null,
      fileSummaryCache: options.fileSummaryCache || null,
    };
    if (options.runsIndex) runOptions.runsIndex = options.runsIndex;
    const { record, runPath, events, runnerKind } = await runOrchestration(parsed.data, runOptions);
    const run = record.orchestratorRun as OrchestrationRun;
    options.sendCachedOrStore(response, cacheKey, fingerprint, 200, {
      context: routeContext(requestContext),
      runId: run.runId,
      status: run.status,
      selectedRecipeId: run.recipeId,
      runnerKind,
      agents: agentSummaries(run),
      eventsUrl: `/api/runs/${run.runId}/events`,
      detailUrl: `/api/orchestrator/runs/${run.runId}`,
      runPath,
      checkpointPath: run.checkpointPath,
      checkpointUrl: `/api/orchestrator/runs/${run.runId}/checkpoint`,
      events,
    });
  });
}


async function handleStartAsync(options: OrchestratorRouteOptions): Promise<void> {
  const { request, response, pathname, requestContext } = options;
  await withJsonBody(request, response, async (body) => {
    if (!options.requireIdempotencyKey(response, requestContext)) return;
    const parsed = startOrchestrationSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: parsed.error.issues[0]?.message || 'invalid orchestrator async request' });
      return;
    }
    const fingerprint = bodyFingerprint(body);
    const cacheKey = options.cacheKeyFor(requestContext, request.method, pathname);
    if (options.sendCachedOrStore(response, cacheKey, fingerprint, 202)) return;
    const runOptions: Parameters<typeof startAsyncOrchestration>[1] = {
      requestContext,
      runStoreRoot: options.runStoreRoot,
      safeTrustedRoot: options.safeTrustedRoot,
      runEvents: options.runEvents || null,
      toolRegistry: options.toolRegistry || null,
      modelConfig: options.modelConfig || null,
      modelCall: options.modelCall,
      fetchImpl: options.fetchImpl,
      cancellation: options.cancellation || null,
      fileSummaryCache: options.fileSummaryCache || null,
    };
    if (options.runsIndex) runOptions.runsIndex = options.runsIndex;
    const { record, runPath, runnerKind } = startAsyncOrchestration(parsed.data, runOptions);
    const run = record.orchestratorRun as OrchestrationRun;
    options.sendCachedOrStore(response, cacheKey, fingerprint, 202, {
      context: routeContext(requestContext),
      runId: run.runId,
      status: run.status,
      selectedRecipeId: run.recipeId,
      runnerKind,
      async: true,
      agents: agentSummaries(run),
      eventsUrl: `/api/runs/${run.runId}/events`,
      detailUrl: `/api/orchestrator/runs/${run.runId}`,
      runPath,
      checkpointPath: run.checkpointPath,
      checkpointUrl: `/api/orchestrator/runs/${run.runId}/checkpoint`,
      events: [],
    });
  });
}
function handleCheckpoint(options: OrchestratorRouteOptions): void {
  const runId = parseOrchestratorRunId(options.pathname, '/api/orchestrator/runs/', '/checkpoint');
  if (!runId) {
    sendJson(options.response, 400, { error: 'Invalid run id' });
    return;
  }
  const record = readOwnedOrchestratorRecord(options, runId);
  if (!record) return;
  const checkpoint = createOrchestrationCheckpointStore({ root: options.runStoreRoot }).load(runId);
  if (!checkpoint) {
    sendJson(options.response, 404, { error: 'Orchestrator checkpoint not found' });
    return;
  }
  sendJson(options.response, 200, { context: routeContext(options.requestContext), checkpoint });
}
function handleDetail(options: OrchestratorRouteOptions): void {
  const runId = parseOrchestratorRunId(options.pathname, '/api/orchestrator/runs/');
  if (!runId) {
    sendJson(options.response, 400, { error: 'Invalid run id' });
    return;
  }
  const record = readOwnedOrchestratorRecord(options, runId);
  if (!record) return;
  sendJson(options.response, 200, orchestratorDetailPayload(record, options.requestContext));
}

async function handleResume(options: OrchestratorRouteOptions): Promise<void> {
  const { request, response, pathname, requestContext } = options;
  const runId = parseOrchestratorRunId(pathname, '/api/orchestrator/runs/', '/resume');
  if (!runId) {
    sendJson(response, 400, { error: 'Invalid run id' });
    return;
  }
  const record = readOwnedOrchestratorRecord(options, runId);
  if (!record) return;
  await withJsonBody(request, response, async (body) => {
    if (!options.requireIdempotencyKey(response, requestContext)) return;
    const fingerprint = bodyFingerprint(body || {});
    const cacheKey = options.cacheKeyFor(requestContext, request.method, pathname);
    if (options.sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
    const runOptions: Parameters<typeof resumeOrchestration>[1] = {
      requestContext,
      runStoreRoot: options.runStoreRoot,
      safeTrustedRoot: options.safeTrustedRoot,
      runEvents: options.runEvents || null,
      toolRegistry: options.toolRegistry || null,
      modelConfig: options.modelConfig || null,
      modelCall: options.modelCall,
      fetchImpl: options.fetchImpl,
      cancellation: options.cancellation || null,
      fileSummaryCache: options.fileSummaryCache || null,
    };
    if (options.runsIndex) runOptions.runsIndex = options.runsIndex;
    try {
      const { record, runPath, events, runnerKind } = await resumeOrchestration(runId, runOptions);
      const run = record.orchestratorRun as OrchestrationRun;
      options.sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        context: routeContext(requestContext),
        runId: run.runId,
        status: run.status,
        selectedRecipeId: run.recipeId,
        runnerKind,
        resumed: true,
        agents: agentSummaries(run),
        eventsUrl: `/api/runs/${run.runId}/events`,
        detailUrl: `/api/orchestrator/runs/${run.runId}`,
        runPath,
        checkpointPath: run.checkpointPath,
        checkpointUrl: `/api/orchestrator/runs/${run.runId}/checkpoint`,
        events,
      });
    } catch (err) {
      const error = err as Error & { statusCode?: number; payload?: Record<string, unknown> };
      sendJson(response, error.statusCode || 500, { error: error.message, ...(error.payload || {}) });
    }
  });
}
function handleCancel(options: OrchestratorRouteOptions): void {
  const runId = parseOrchestratorRunId(options.pathname, '/api/orchestrator/runs/', '/cancel');
  if (!runId) {
    sendJson(options.response, 400, { error: 'Invalid run id' });
    return;
  }
  const record = readOwnedOrchestratorRecord(options, runId);
  if (!record) return;
  const cancelled = options.cancellation?.cancel?.(
    runId,
    'user_cancelled',
    orchestratorOwner(options.requestContext),
  ) === true;
  if (cancelled) {
    sendJson(options.response, 200, {
      context: routeContext(options.requestContext),
      runId,
      cancelled: true,
      status: record.status,
    });
    return;
  }
  sendJson(options.response, 409, {
    error: 'Orchestrator run is not active, may complete synchronously, or cannot be cancelled after terminal persistence',
    status: record.status,
    cancelled: false,
  });
}

export async function handleOrchestratorRoutes(options: OrchestratorRouteOptions): Promise<boolean> {
  const { request, response, pathname, requestContext } = options;
  if (request.method === 'GET' && pathname === '/api/orchestrator/agents') {
    sendJson(response, 200, { context: routeContext(requestContext), agents: createDefaultAgentRegistry().list() });
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/orchestrator/run') {
    await handleStart(options);
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/orchestrator/run-async') {
    await handleStartAsync(options);
    return true;
  }
  if (request.method === 'GET' && pathname.startsWith('/api/orchestrator/runs/') && pathname.endsWith('/checkpoint')) {
    handleCheckpoint(options);
    return true;
  }
  if (request.method === 'GET' && pathname.startsWith('/api/orchestrator/runs/')) {
    handleDetail(options);
    return true;
  }
  if (request.method === 'POST' && pathname.startsWith('/api/orchestrator/runs/') && pathname.endsWith('/resume')) {
    await handleResume(options);
    return true;
  }
  if (request.method === 'POST' && pathname.startsWith('/api/orchestrator/runs/') && pathname.endsWith('/cancel')) {
    handleCancel(options);
    return true;
  }
  return false;
}
