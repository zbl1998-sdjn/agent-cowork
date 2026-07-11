import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleRunRoutes } from '../src/routes/run-routes.js';
import { RunEventBus } from '../src/runtime/run-events.js';
import { writeRunRecord } from '../src/runtime/run-store.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';

type JsonRecord = Record<string, unknown>;
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);
type RouteResponse = HttpResponseLike & {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  writes: string[];
  write(chunk?: string | Buffer): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  json(): JsonRecord;
  emitClose(): void;
};

class FakeRequest implements HttpRequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(readonly method: string, headers: Record<string, string> = {}) {
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
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

  emitClose(): void {
    for (const listener of this.listeners.get('close') || []) listener();
  }
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-run-routes-'));
}

function capturedResponse(): RouteResponse {
  const listeners = new Map<string, RequestListener[]>();
  return {
    status: 0,
    headers: {},
    body: '',
    writes: [],
    writeHead(statusCode, headers = {}) {
      this.status = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    write(chunk = '') {
      this.writes.push(String(chunk));
    },
    on(event: string, listener: RequestListener) {
      const current = listeners.get(event) || [];
      current.push(listener);
      listeners.set(event, current);
      return this;
    },
    json() {
      const parsed = JSON.parse(this.body || '{}') as unknown;
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'captured response body should be an object');
      return parsed as JsonRecord;
    },
    emitClose() {
      for (const listener of listeners.get('close') || []) listener();
    },
  };
}

function arrayField(source: JsonRecord, key: string, label = key): unknown[] {
  const value = source[key];
  assert.ok(Array.isArray(value), `${label} should be an array`);
  return value;
}

function createRunsIndex() {
  const calls: unknown[] = [];
  return {
    calls,
    list: (options?: unknown) => {
      calls.push(options);
      return [{ id: 'run_indexed', tenantId: 'tenant_runs', status: 'succeeded' }];
    },
    stats: (options?: unknown) => ({ ok: true, options }),
  };
}

test('run routes expose tenant-scoped lists, indexed filters, and detail records', async () => {
  const root = path.join(tempRoot(), 'runs');
  const context = { tenantId: 'tenant_runs', userId: 'user_runs', traceId: 'trace_runs' };
  writeRunRecord(root, {
    id: 'run_visible',
    type: 'agent-chat',
    status: 'succeeded',
    context: { tenantId: 'tenant_runs', userId: 'user_runs', traceId: 'trace_record' },
    startedAt: '2026-06-19T12:00:00.000Z',
    input: { prompt: 'visible prompt' },
  });
  writeRunRecord(root, {
    id: 'run_hidden',
    type: 'agent-chat',
    status: 'succeeded',
    context: { tenantId: 'tenant_other', userId: 'user_other' },
    startedAt: '2026-06-19T13:00:00.000Z',
    input: { prompt: 'hidden prompt' },
  });

  const runsIndex = createRunsIndex();
  const runEvents = new RunEventBus();
  let response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs',
    requestUrl: new URL('http://local.test/api/runs?limit=5'),
    requestContext: context,
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 200);
  const visibleRuns = arrayField(response.json(), 'runs');
  assert.deepEqual(visibleRuns.map((run) => String((run as JsonRecord).id)), ['run_visible']);

  response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs/index',
    requestUrl: new URL('http://local.test/api/runs/index?limit=7&status=succeeded&type=agent-chat&recipeId=daily&userId=user_runs'),
    requestContext: context,
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 200);
  assert.deepEqual(runsIndex.calls.at(-1), {
    tenantId: 'tenant_runs',
    userId: 'user_runs',
    limit: 7,
    status: 'succeeded',
    type: 'agent-chat',
    recipeId: 'daily',
  });
  assert.equal((arrayField(response.json(), 'runs')[0] as JsonRecord).id, 'run_indexed');

  response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs/run_visible',
    requestUrl: new URL('http://local.test/api/runs/run_visible'),
    requestContext: context,
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 200);
  assert.equal(response.json().id, 'run_visible');

  response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs/run_hidden',
    requestUrl: new URL('http://local.test/api/runs/run_hidden'),
    requestContext: context,
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 404);

  response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs/bad%2Fescape',
    requestUrl: new URL('http://local.test/api/runs/bad%2Fescape'),
    requestContext: context,
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 400);
});

test('run routes reject incomplete request identities and hide invalid stored owners', async () => {
  const root = path.join(tempRoot(), 'runs');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'run_corrupt.json'),
    JSON.stringify({
      id: 'run_corrupt',
      status: 'succeeded',
      context: { tenantId: 'tenant_runs' },
    }),
    'utf8',
  );
  const runsIndex = createRunsIndex();
  const runEvents = new RunEventBus();

  let response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs',
    requestUrl: new URL('http://local.test/api/runs'),
    requestContext: { tenantId: 'tenant_runs', traceId: 'trace_runs' },
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 401);

  response = capturedResponse();
  assert.equal(await handleRunRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/runs/run_corrupt',
    requestUrl: new URL('http://local.test/api/runs/run_corrupt'),
    requestContext: { tenantId: 'tenant_runs', userId: 'user_runs', traceId: 'trace_runs' },
    runStoreRoot: root,
    runsIndex,
    runEvents,
  }), true);
  assert.equal(response.status, 404);
});

test('run events route replays visible history once and unsubscribes on close', async () => {
  const root = path.join(tempRoot(), 'runs');
  const context = { tenantId: 'tenant_events', userId: 'user_events', traceId: 'trace_events' };
  const runId = 'run_events_direct';
  writeRunRecord(root, {
    id: runId,
    type: 'recipe',
    status: 'succeeded',
    context: { tenantId: 'tenant_events', userId: 'user_events' },
    events: [
      { seq: 1, ts: '2026-06-19T12:00:00.000Z', type: 'start' },
      { seq: 2, ts: '2026-06-19T12:00:01.000Z', type: 'done' },
    ],
  });

  const request = new FakeRequest('GET', { 'last-event-id': '1' });
  const response = capturedResponse();
  const runEvents = new RunEventBus();
  assert.equal(await handleRunRoutes({
    request,
    response,
    pathname: `/api/runs/${runId}/events`,
    requestUrl: new URL(`http://local.test/api/runs/${runId}/events`),
    requestContext: context,
    runStoreRoot: root,
    runsIndex: createRunsIndex(),
    runEvents,
  }), true);

  assert.equal(response.status, 200);
  assert.equal(response.headers['x-trace-id'], 'trace_events');
  assert.equal(runEvents.subscriberCount(runId, context), 1);
  const initialStream = response.writes.join('');
  assert.match(initialStream, /retry: 3000/);
  assert.doesNotMatch(initialStream, /event: start/);
  assert.match(initialStream, /event: done/);

  runEvents.publish(runId, { type: 'live_update', message: 'after subscribe' }, context);
  assert.match(response.writes.join(''), /event: live_update/);
  request.emitClose();
  assert.equal(runEvents.subscriberCount(runId, context), 0);
  runEvents.publish(runId, { type: 'after_close' }, context);
  assert.doesNotMatch(response.writes.join(''), /event: after_close/);
});
