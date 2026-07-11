import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrchestrationCheckpointStore, FileSummaryCache } from '../src/orchestrator/index.js';
import { createCancellationRegistry } from '../src/runtime/cancellation.js';
import { writeRunRecord } from '../src/runtime/run-store.js';
import { handleOrchestratorRoutes } from '../src/routes/orchestrator-routes.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';

type JsonRecord = Record<string, unknown>;
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);
type CapturedResponse = HttpResponseLike & { status: number; headers: Record<string, string | number>; body: string; json(): JsonRecord };
type RequestContext = { tenantId: string; userId: string; traceId: string; idempotencyKey?: string; securityMode?: string };

type CacheEntry = { fingerprint: string; status: number; payload: unknown };

class FakeJsonRequest implements HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(method: string, private readonly body?: unknown) {
    this.method = method;
    this.headers = body === undefined ? {} : { 'content-type': 'application/json' };
    void Promise.resolve().then(() => {
      if (this.body !== undefined) this.emit('data', Buffer.from(JSON.stringify(this.body)));
      this.emit('end');
    });
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: RequestListener): this;
  on(event: string, listener: SupportedRequestListener): this {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener as RequestListener);
    this.listeners.set(event, listeners);
    return this;
  }

  resume(): void {
    // Test request bodies are emitted eagerly; there is nothing to drain.
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function capturedResponse(): CapturedResponse {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.status = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      const parsed = JSON.parse(this.body || '{}') as unknown;
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'captured response body should be an object');
      return parsed as JsonRecord;
    },
  };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-orchestrator-route-'));
}

function objectField(source: JsonRecord, key: string, label = key): JsonRecord {
  const value = source[key];
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

function arrayField(source: JsonRecord, key: string, label = key): unknown[] {
  const value = source[key];
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value;
}

function routeHarness(root: string, context: RequestContext, fileSummaryCache = new FileSummaryCache()) {
  const cache = new Map<string, CacheEntry>();
  const upserts: unknown[] = [];
  return {
    upserts,
    options(request: FakeJsonRequest, response: CapturedResponse, pathname: string) {
      return {
        request,
        response,
        pathname,
        requestContext: context,
        runStoreRoot: path.join(root, '.AgentCowork', 'runs'),
        runsIndex: { upsert: (record: unknown) => { upserts.push(record); return record; } },
        cacheKeyFor: (ctx: RequestContext, method?: string, routePath?: string) => `${ctx.tenantId}:${ctx.idempotencyKey}:${method}:${routePath}`,
        requireIdempotencyKey: (res: HttpResponseLike, ctx: RequestContext) => {
          if (ctx.idempotencyKey) return true;
          res.writeHead(428, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Idempotency-Key required' }));
          return false;
        },
        sendCachedOrStore: (res: HttpResponseLike, key: string, fingerprint: string, status: number, payload?: unknown) => {
          const existing = cache.get(key);
          if (payload === undefined) {
            if (!existing || existing.fingerprint !== fingerprint) return false;
            res.writeHead(existing.status, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(existing.payload));
            return true;
          }
          cache.set(key, { fingerprint, status, payload });
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload));
          return true;
        },
        fileSummaryCache,
        safeTrustedRoot: (input?: unknown) => {
          const candidate = String(input || root);
          if (path.resolve(candidate) !== path.resolve(root)) {
            throw new Error('trusted root outside configured jail');
          }
          return root;
        },
      };
    },
  };
}

test('orchestrator route starts a weekly report run, persists trace, and exposes detail', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_orchestrator',
    userId: 'user_orchestrator',
    traceId: 'trace_orchestrator',
    idempotencyKey: 'idem-orchestrator',
    securityMode: 'local_strict',
  };
  const harness = routeHarness(root, context);
  const request = new FakeJsonRequest('POST', {
    workspaceRoot: root,
    userGoal: 'Create a weekly report',
    refs: [{
      refId: 'weekly-note',
      kind: 'file',
      label: 'weekly.md',
      dataTags: ['internal'],
      text: 'Done: shipped the typed orchestrator route with api_key=secret-value.',
      summary: 'Shipped the typed orchestrator route.',
      uri: 'file:///weekly.md',
    }],
  });
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(harness.options(request, response, '/api/orchestrator/run')), true);
  assert.equal(response.status, 200);
  const body = response.json();
  const runId = String(body.runId);
  assert.match(runId, /^run_/);
  assert.equal(body.status, 'completed');
  assert.equal(body.selectedRecipeId, 'weekly-report');
  assert.equal(body.eventsUrl, `/api/runs/${runId}/events`);
  assert.ok(fs.existsSync(String(body.runPath)), 'run record should be written');
  assert.ok(fs.existsSync(String(body.checkpointPath)), 'checkpoint should be written');
  assert.equal(body.checkpointUrl, `/api/orchestrator/runs/${runId}/checkpoint`);
  assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'runs', `${runId}.events.jsonl`)), 'JSONL trace should be written');
  assert.equal(harness.upserts.length, 1);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}/checkpoint`)), true);
  assert.equal(response.status, 200);
  const checkpoint = objectField(response.json(), 'checkpoint');
  assert.equal(checkpoint.status, 'completed');
  assert.equal(arrayField(checkpoint, 'completedStepIds').length, 6);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('POST', {}), response, `/api/orchestrator/runs/${runId}/resume`)), true);
  assert.equal(response.status, 409);
  assert.match(String(response.json().error), /terminal/);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
  assert.equal(response.status, 200);
  const detail = response.json();
  const run = objectField(detail, 'run');
  assert.equal(run.status, 'completed');
  assert.equal(run.recipeId, 'weekly-report');
  assert.equal(arrayField(detail, 'tasks').length, 4);
  assert.equal(arrayField(detail, 'results').length, 4);
  const timeline = arrayField(detail, 'timeline').map((event) => event as JsonRecord);
  assert.ok(timeline.some((event) => event.type === 'budget_updated' && event.budget));
});

test('orchestrator route rejects client securityMode overrides', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_security_override',
    userId: 'user_security_override',
    traceId: 'trace_security_override',
    idempotencyKey: 'idem-security-override',
    securityMode: 'air_gap',
  };
  const harness = routeHarness(root, context);
  const response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('POST', {
    workspaceRoot: root,
    userGoal: 'Attempt to weaken the server security mode',
    securityMode: 'cloud_opt_in',
  }), response, '/api/orchestrator/run')), true);
  assert.equal(response.status, 400);
});

test('orchestrator route derives run securityMode from server context', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_server_security',
    userId: 'user_server_security',
    traceId: 'trace_server_security',
    idempotencyKey: 'idem-server-security',
    securityMode: 'enterprise_local',
  };
  const harness = routeHarness(root, context);
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('POST', {
    workspaceRoot: root,
    userGoal: 'Use the server-owned security mode',
  }), response, '/api/orchestrator/run')), true);
  assert.equal(response.status, 200);
  const runId = String(response.json().runId);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(
    harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`),
  ), true);
  assert.equal(response.status, 200);
  assert.equal(objectField(response.json(), 'run').securityMode, 'enterprise_hybrid');
});

test('orchestrator route reuses file summary cache across runs for the same tenant', async () => {
  const root = tempRoot();
  const fileSummaryCache = new FileSummaryCache();
  const firstContext: RequestContext = {
    tenantId: 'tenant_cache',
    userId: 'user_cache',
    traceId: 'trace_cache_1',
    idempotencyKey: 'idem-cache-1',
    securityMode: 'local_strict',
  };
  const secondContext: RequestContext = {
    ...firstContext,
    traceId: 'trace_cache_2',
    idempotencyKey: 'idem-cache-2',
  };
  const sourceText = 'Stable route source text for summary cache reuse.';
  const firstHarness = routeHarness(root, firstContext, fileSummaryCache);
  const secondHarness = routeHarness(root, secondContext, fileSummaryCache);

  let response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(firstHarness.options(new FakeJsonRequest('POST', {
    workspaceRoot: root,
    userGoal: 'Create a weekly report with cache',
    refs: [{
      refId: 'cache-note',
      kind: 'file',
      label: 'cache.md',
      dataTags: ['internal'],
      text: sourceText,
      summary: 'First route cached summary.',
      uri: 'file:///cache.md',
    }],
  }), response, '/api/orchestrator/run')), true);
  assert.equal(response.status, 200);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(secondHarness.options(new FakeJsonRequest('POST', {
    workspaceRoot: root,
    userGoal: 'Create a weekly report with cache again',
    refs: [{
      refId: 'cache-note',
      kind: 'file',
      label: 'cache.md',
      dataTags: ['internal'],
      text: sourceText,
      summary: 'Second route supplied summary should be ignored on cache hit.',
      uri: 'file:///cache.md',
    }],
  }), response, '/api/orchestrator/run')), true);
  assert.equal(response.status, 200);
  const body = response.json();
  const events = arrayField(body, 'events').map((event) => event as JsonRecord);
  assert.equal(events.some((event) => event.type === 'summary_cache_updated' && Number(event.hits) > 0), true);

  const runId = String(body.runId);
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(secondHarness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
  assert.equal(response.status, 200);
  const detail = response.json();
  const tasks = arrayField(detail, 'tasks').map((task) => task as JsonRecord);
  const writerTask = tasks.find((task) => task.agentId === 'writer');
  assert.ok(writerTask, 'writer task should exist');
  const writerRef = arrayField(writerTask, 'inputRefs')[0] as JsonRecord;
  assert.equal(writerRef.summary, 'First route cached summary.');
  const summaryCache = objectField(objectField(writerRef, 'metadata'), 'summaryCache');
  assert.equal(summaryCache.hit, true);
});
test('orchestrator route enforces idempotency and tenant-scoped detail reads', async () => {
  const root = tempRoot();
  const context: RequestContext = { tenantId: 'tenant_a', userId: 'user_a', traceId: 'trace_a' };
  let harness = routeHarness(root, context);
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(harness.options(
    new FakeJsonRequest('POST', { workspaceRoot: root, userGoal: 'Create a weekly report' }),
    response,
    '/api/orchestrator/run',
  )), true);
  assert.equal(response.status, 428);

  const runContext: RequestContext = { ...context, idempotencyKey: 'idem-a' };
  harness = routeHarness(root, runContext);
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(
    new FakeJsonRequest('POST', { workspaceRoot: root, userGoal: 'Create a weekly report' }),
    response,
    '/api/orchestrator/run',
  )), true);
  const runId = String(response.json().runId);

  const otherTenantHarness = routeHarness(root, { tenantId: 'tenant_b', userId: 'user_b', traceId: 'trace_b', idempotencyKey: 'idem-b' });
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(otherTenantHarness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
  assert.equal(response.status, 404);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('POST', {}), response, `/api/orchestrator/runs/${runId}/cancel`)), true);
  assert.equal(response.status, 409);
  assert.match(String(response.json().error), /complete synchronously/);
});

test('orchestrator routes hide a run from sibling users before cancel or resume side effects', async () => {
  const root = tempRoot();
  const ownerContext: RequestContext = {
    tenantId: 'tenant_shared',
    userId: 'user_owner',
    traceId: 'trace_owner',
    idempotencyKey: 'idem-owner',
  };
  const ownerHarness = routeHarness(root, ownerContext);
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(ownerHarness.options(
    new FakeJsonRequest('POST', { workspaceRoot: root, userGoal: 'Create an owner-only report' }),
    response,
    '/api/orchestrator/run',
  )), true);
  assert.equal(response.status, 200);
  const runId = String(response.json().runId);

  const siblingHarness = routeHarness(root, {
    tenantId: 'tenant_shared',
    userId: 'user_sibling',
    traceId: 'trace_sibling',
    idempotencyKey: 'idem-sibling',
  });

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(siblingHarness.options(
    new FakeJsonRequest('GET'),
    response,
    `/api/orchestrator/runs/${runId}`,
  )), true);
  assert.equal(response.status, 404);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(siblingHarness.options(
    new FakeJsonRequest('GET'),
    response,
    `/api/orchestrator/runs/${runId}/checkpoint`,
  )), true);
  assert.equal(response.status, 404);

  let cancelCalls = 0;
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes({
    ...siblingHarness.options(new FakeJsonRequest('POST', {}), response, `/api/orchestrator/runs/${runId}/cancel`),
    cancellation: {
      cancel: () => {
        cancelCalls += 1;
        return true;
      },
    },
  }), true);
  assert.equal(response.status, 404);
  assert.equal(cancelCalls, 0);

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(siblingHarness.options(
    new FakeJsonRequest('POST', {}),
    response,
    `/api/orchestrator/runs/${runId}/resume`,
  )), true);
  assert.equal(response.status, 404);
  assert.match(String(response.json().error), /run not found/i);
});


test('orchestrator route resumes a non-terminal checkpoint and persists detail', async () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const context: RequestContext = {
    tenantId: 'tenant_resume',
    userId: 'user_resume',
    traceId: 'trace_resume',
    idempotencyKey: 'idem-resume',
    securityMode: 'local_strict',
  };
  const checkpointStore = createOrchestrationCheckpointStore({ root: runStoreRoot });
  checkpointStore.save({
    version: 1,
    runId: 'run_route_resume',
    userGoal: 'Create a weekly report from checkpoint',
    recipeId: 'weekly-report',
    mode: 'workflow',
    status: 'running',
    workspaceRoot: root,
    securityMode: 'local_strict',
    agents: ['researcher', 'writer', 'verifier', 'security_reviewer'],
    refs: [{
      refId: 'resume-note',
      kind: 'file',
      label: 'resume.md',
      dataTags: ['internal'],
      text: 'Resume this checkpoint into a final report.',
      summary: 'Checkpoint resume source note.',
      uri: 'file:///resume.md',
      metadata: {},
    }],
    tasks: [],
    results: [],
    completedStepIds: [],
    currentStepId: 'research',
    eventsPath: path.join(runStoreRoot, 'run_route_resume.events.jsonl'),
    checkpointPath: '',
    artifacts: [],
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  });
  writeRunRecord(runStoreRoot, {
    id: 'run_route_resume',
    type: 'orchestrator',
    status: 'running',
    context: {
      tenantId: context.tenantId,
      userId: context.userId,
      traceId: context.traceId,
    },
    startedAt: '2026-07-05T00:00:00.000Z',
  });
  const harness = routeHarness(root, context);
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('POST', {}), response, '/api/orchestrator/runs/run_route_resume/resume')), true);
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.resumed, true);
  assert.equal(body.status, 'completed');
  assert.equal(body.runId, 'run_route_resume');
  assert.ok(fs.existsSync(String(body.runPath)), 'resumed run record should be written');
  assert.ok(fs.existsSync(String(body.checkpointPath)), 'resumed checkpoint should be updated');

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, '/api/orchestrator/runs/run_route_resume')), true);
  assert.equal(response.status, 200);
  const detail = response.json();
  assert.equal(arrayField(detail, 'tasks').length, 4);
  assert.equal(arrayField(detail, 'results').length, 4);
});
test('orchestrator route starts office-team through subagent adapter', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_office',
    userId: 'user_office',
    traceId: 'trace_office',
    idempotencyKey: 'idem-office',
    securityMode: 'local_strict',
  };
  const harness = routeHarness(root, context);
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolRegistry = {
    has: (name: string) => name === 'SearchWorkspace',
    descriptor: (name: string) => name === 'SearchWorkspace'
      ? { risk: 'low', mutating: false, requiresApproval: false }
      : null,
    call: async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return { content: [{ text: 'office handoff evidence from SearchWorkspace' }] };
    },
  };
  const request = new FakeJsonRequest('POST', {
    workspaceRoot: root,
    recipeId: 'office-team',
    userGoal: 'Prepare an office handoff from the provided notes.',
    refs: [{
      refId: 'office-note',
      kind: 'file',
      label: 'office.md',
      dataTags: ['internal'],
      text: 'Need a document brief, presentation outline, and file organization preview.',
      summary: 'Office handoff source note.',
      uri: 'file:///office.md',
    }],
  });
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes({
    ...harness.options(request, response, '/api/orchestrator/run'),
    toolRegistry,
  }), true);
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.selectedRecipeId, 'office-team');
  assert.equal(body.runnerKind, 'subagent');
  assert.ok(toolCalls.length >= 1, 'office-team should call SearchWorkspace through subagent adapter');

  const runId = String(body.runId);
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
  assert.equal(response.status, 200);
  const detail = response.json();
  assert.equal(arrayField(detail, 'tasks').length, 6);
  const results = arrayField(detail, 'results').map((result) => result as JsonRecord);
  assert.equal(results.length, 6);
  const timeline = arrayField(detail, 'timeline').map((event) => event as JsonRecord);
  const handoffs = timeline.filter((event) => event.type === 'handoff_started');
  assert.equal(handoffs.length, 6);
  const firstHandoff = handoffs[0];
  assert.ok(firstHandoff, 'office-team detail should expose first handoff event');
  assert.equal(firstHandoff.toAgentId, 'excel_helper');
  assert.deepEqual(arrayField(firstHandoff, 'contextRefIds'), ['office-note']);
  assert.ok(Number(objectField(firstHandoff, 'budget').maxRuntimeMs) > 0, 'handoff event should expose budget');
  assert.ok(results.some((result) => objectField(result, 'structured').subagentRunId), 'detail should expose subagent evidence');
});


test('orchestrator route starts ppt-from-folder through subagent adapter', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_ppt',
    userId: 'user_ppt',
    traceId: 'trace_ppt',
    idempotencyKey: 'idem-ppt',
    securityMode: 'local_strict',
  };
  const harness = routeHarness(root, context);
  const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const toolRegistry = {
    has: (name: string) => name === 'SearchWorkspace',
    descriptor: (name: string) => name === 'SearchWorkspace'
      ? { risk: 'low', mutating: false, requiresApproval: false }
      : null,
    call: async (name: string, args: Record<string, unknown>) => {
      toolCalls.push({ name, args });
      return { content: [{ text: 'presentation evidence from SearchWorkspace' }] };
    },
  };
  const request = new FakeJsonRequest('POST', {
    workspaceRoot: root,
    recipeId: 'ppt-from-folder',
    userGoal: 'Turn these folder notes into a presentation outline.',
    refs: [{
      refId: 'folder-note',
      kind: 'file',
      label: 'folder-summary.md',
      dataTags: ['internal'],
      text: 'The folder includes roadmap notes, metrics, and rollout risks.',
      summary: 'Folder source note for deck.',
      uri: 'file:///folder-summary.md',
    }],
  });
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes({
    ...harness.options(request, response, '/api/orchestrator/run'),
    toolRegistry,
  }), true);
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.selectedRecipeId, 'ppt-from-folder');
  assert.equal(body.runnerKind, 'subagent');
  assert.ok(toolCalls.length >= 1, 'ppt-from-folder should call SearchWorkspace through subagent adapter');

  const runId = String(body.runId);
  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
  assert.equal(response.status, 200);
  const detail = response.json();
  assert.equal(arrayField(detail, 'tasks').length, 5);
  const results = arrayField(detail, 'results').map((result) => result as JsonRecord);
  assert.equal(results.length, 5);
  const timeline = arrayField(detail, 'timeline').map((event) => event as JsonRecord);
  const handoffs = timeline.filter((event) => event.type === 'handoff_started');
  assert.equal(handoffs.length, 5);
  const firstHandoff = handoffs[0];
  assert.ok(firstHandoff, 'ppt-from-folder detail should expose first handoff event');
  assert.equal(firstHandoff.toAgentId, 'researcher');
  assert.deepEqual(arrayField(firstHandoff, 'contextRefIds'), ['folder-note']);
  assert.ok(Number(objectField(firstHandoff, 'budget').maxRuntimeMs) > 0, 'handoff event should expose budget');
  assert.ok(results.some((result) => objectField(result, 'structured').subagentRunId), 'detail should expose subagent evidence');
});
test('orchestrator async route can cancel an active provider-backed run', async () => {
  const root = tempRoot();
  const context: RequestContext = {
    tenantId: 'tenant_async',
    userId: 'user_async',
    traceId: 'trace_async',
    idempotencyKey: 'idem-async',
    securityMode: 'local_strict',
  };
  const harness = routeHarness(root, context);
  const cancellation = createCancellationRegistry();
  let modelCalls = 0;
  const modelCall = async (args: { signal?: AbortSignal | null }) => {
    modelCalls += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      args.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        const err = new Error('aborted by orchestrator cancel');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
    return { content: 'late provider output', provider: 'test-provider', model: 'test-model' };
  };
  let response = capturedResponse();

  assert.equal(await handleOrchestratorRoutes({
    ...harness.options(new FakeJsonRequest('POST', {
      workspaceRoot: root,
      userGoal: 'Create an async provider-backed weekly report',
    }), response, '/api/orchestrator/run-async'),
    cancellation,
    modelConfig: {
      configured: true,
      provider: 'openai/local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'test-key',
      model: 'test-model',
    },
    modelCall,
  }), true);
  assert.equal(response.status, 202);
  const body = response.json();
  const runId = String(body.runId);
  assert.equal(body.status, 'running');
  assert.equal(body.async, true);
  assert.equal(body.runnerKind, 'provider');
  assert.ok(cancellation.signal(runId, context), 'async cancellation must register under tenant and user');
  assert.equal(cancellation.signal(runId), null, 'async cancellation must not use the legacy unscoped slot');

  response = capturedResponse();
  assert.equal(await handleOrchestratorRoutes({
    ...harness.options(new FakeJsonRequest('POST', {}), response, `/api/orchestrator/runs/${runId}/cancel`),
    cancellation,
  }), true);
  assert.equal(response.status, 200);
  assert.equal(response.json().cancelled, true);

  let detail: JsonRecord | null = null;
  for (let i = 0; i < 50; i += 1) {
    response = capturedResponse();
    assert.equal(await handleOrchestratorRoutes(harness.options(new FakeJsonRequest('GET'), response, `/api/orchestrator/runs/${runId}`)), true);
    detail = response.json();
    const run = objectField(detail, 'run');
    if (run.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(detail, 'detail should be readable');
  assert.equal(objectField(detail, 'run').status, 'cancelled');
  assert.ok(modelCalls >= 1, 'provider adapter should have started before cancellation');
});
