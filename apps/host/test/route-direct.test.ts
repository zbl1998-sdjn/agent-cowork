import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { handlePlanRoutes } from '../src/routes/plan-routes.js';
import { handlePromptRoutes } from '../src/routes/prompt-routes.js';
import { handleSearchRoutes } from '../src/routes/search-routes.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';
import type { PromptContext, PromptRefiner, PromptRefineResult } from '../src/kimi/prompt/refiner.js';
import type { MemoryStoreLike } from '../src/memory/profile.js';
import type { Planner, PlanToolRegistry } from '../src/runtime/plan-builder.js';

type JsonRecord = Record<string, unknown>;
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);
type CapturedResponse = HttpResponseLike & { status: number; body: string; json(): JsonRecord };

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
    body: '',
    writeHead(statusCode) {
      this.status = statusCode;
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

function requirePromptContext(value: PromptContext | null): PromptContext {
  assert.ok(value, 'prompt refiner should receive a context');
  return value;
}

function safeRootFor(root: string): (input?: unknown) => string {
  return (input?: unknown) => {
    const candidate = String(input || root);
    if (candidate !== root) {
      throw new Error('trusted root outside configured jail');
    }
    return root;
  };
}

test('prompt route validates body, injects profile context, and rejects escaped roots', async () => {
  const root = makeTestWorkspace('kcw-route-prompt');
  const requestContext = { tenantId: 'tenant-route', userId: 'user-route', traceId: 'trace-route' };
  const memoryStore: MemoryStoreLike = {
    readMemoryNote: async () => JSON.stringify({
      version: 1,
      entries: [
        { type: 'project', key: 'current', value: 'Agent Cowork', evidence: 'test', scope: 'user', updatedAt: '2026-06-19T00:00:00.000Z' },
        { type: 'term', key: 'regression', value: '回归', evidence: 'test', scope: 'user', updatedAt: '2026-06-19T00:00:00.000Z' },
      ],
    }),
    writeMemoryNote: async () => undefined,
  };
  let capturedContext: PromptContext | null = null;
  const promptRefiner: PromptRefiner = {
    refine: async (prompt, ctx = {}): Promise<PromptRefineResult> => {
      capturedContext = ctx;
      return {
        refined: `refined:${String(prompt)}`,
        changed: true,
        needsClarification: false,
        intent: 'fix',
        missing: [],
      };
    },
  };

  let response = capturedResponse();
  assert.equal(await handlePromptRoutes({
    request: new FakeJsonRequest('GET'),
    response,
    pathname: '/api/prompt/refine',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root), config: { promptRefiner }, memoryStore },
  }), false);
  assert.equal(response.status, 0);

  response = capturedResponse();
  assert.equal(await handlePromptRoutes({
    request: new FakeJsonRequest('POST', { prompt: '修复登录回归', context: { profile: { terms: ['supplied-term'] } } }),
    response,
    pathname: '/api/prompt/refine',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root), config: { promptRefiner }, memoryStore },
  }), true);
  assert.equal(response.status, 200);
  assert.equal(response.json().refined, 'refined:修复登录回归');
  const refinedContext = requirePromptContext(capturedContext);
  assert.equal(refinedContext.trustedRoot, root);
  assert.equal(refinedContext.project, 'Agent Cowork');
  const profile = objectField(refinedContext as unknown as JsonRecord, 'profile', 'prompt context profile');
  assert.deepEqual(arrayField(profile, 'terms'), ['regression = 回归', 'supplied-term']);

  response = capturedResponse();
  assert.equal(await handlePromptRoutes({
    request: new FakeJsonRequest('POST', { prompt: '', context: [] }),
    response,
    pathname: '/api/prompt/refine',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root), config: { promptRefiner }, memoryStore: null },
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /prompt is required/i);

  response = capturedResponse();
  assert.equal(await handlePromptRoutes({
    request: new FakeJsonRequest('POST', { prompt: '修复登录回归', trustedRoot: path.dirname(root) }),
    response,
    pathname: '/api/prompt/refine',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root), config: { promptRefiner }, memoryStore: null },
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /trusted root/i);
});

test('plan route keeps generated plans inside the registered tool boundary', async () => {
  const requestContext = { tenantId: 'tenant-route', userId: 'user-route', traceId: 'trace-route' };
  const registry: PlanToolRegistry = {
    search: () => [{ name: 'Read', source: 'builtin' }],
    has: (tool) => tool === 'Read' || tool === 'recipe.meeting-actions',
  };
  const planner: Planner = async ({ goal }) => ({
    goal,
    steps: [
      { tool: 'Read', args: { path: 'README.md' }, rationale: 'inspect repo' },
      { tool: 'NotRegistered', args: { path: 'secret' }, rationale: 'must be filtered' },
      { tool: 'recipe.meeting-actions', args: ['invalid args'], rationale: 123 },
    ],
  });

  let response = capturedResponse();
  assert.equal(await handlePlanRoutes({
    request: new FakeJsonRequest('POST', { goal: '检查回归' }),
    response,
    pathname: '/api/plan',
    requestContext,
    toolRegistry: null,
    planner,
  }), false);
  assert.equal(response.status, 0);

  response = capturedResponse();
  assert.equal(await handlePlanRoutes({
    request: new FakeJsonRequest('POST', { goal: '检查回归' }),
    response,
    pathname: '/api/plan',
    requestContext,
    toolRegistry: registry,
    planner,
  }), true);
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.goal, '检查回归');
  assert.equal(body.executable, true);
  const steps = arrayField(body, 'steps');
  assert.deepEqual(steps.map((step) => objectField(step as JsonRecord, 'args')), [{ path: 'README.md' }, {}]);
  assert.deepEqual(steps.map((step) => String((step as JsonRecord).tool)), ['Read', 'recipe.meeting-actions']);
  assert.equal(objectField(body, 'context').tenantId, 'tenant-route');

  response = capturedResponse();
  assert.equal(await handlePlanRoutes({
    request: new FakeJsonRequest('POST', { goal: '   ' }),
    response,
    pathname: '/api/plan',
    requestContext,
    toolRegistry: registry,
    planner,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /goal is required/i);
});

test('workspace search route validates inputs and returns jailed source excerpts', async () => {
  const root = makeTestWorkspace('kcw-route-search');
  fs.writeFileSync(path.join(root, 'notes.md'), 'alpha\nneedle regression evidence\nomega\n', 'utf8');
  fs.writeFileSync(path.join(root, 'ignored.bin'), Buffer.from([0, 1, 2, 3]));
  const requestContext = { tenantId: 'tenant-route', userId: 'user-route', traceId: 'trace-route' };

  let response = capturedResponse();
  assert.equal(await handleSearchRoutes({
    request: new FakeJsonRequest('GET'),
    response,
    pathname: '/api/workspace/search',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root) },
  }), false);
  assert.equal(response.status, 0);

  response = capturedResponse();
  assert.equal(await handleSearchRoutes({
    request: new FakeJsonRequest('POST', { query: 'needle', limit: '5', maxFiles: '20', maxFileBytes: '4096' }),
    response,
    pathname: '/api/workspace/search',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root) },
  }), true);
  assert.equal(response.status, 200);
  const body = response.json();
  assert.equal(body.query, 'needle');
  assert.equal(body.root, root);
  assert.equal(body.indexedFiles, 1);
  const sources = arrayField(body, 'sources');
  assert.equal((sources[0] as JsonRecord).relativePath, 'notes.md');
  assert.match(String((sources[0] as JsonRecord).excerpt), /needle regression evidence/);
  assert.equal(objectField(body, 'context').traceId, 'trace-route');

  response = capturedResponse();
  assert.equal(await handleSearchRoutes({
    request: new FakeJsonRequest('POST', { query: '', maxFiles: Number.POSITIVE_INFINITY }),
    response,
    pathname: '/api/workspace/search',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root) },
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /query is required/i);

  response = capturedResponse();
  assert.equal(await handleSearchRoutes({
    request: new FakeJsonRequest('POST', { query: 'needle', trustedRoot: path.dirname(root) }),
    response,
    pathname: '/api/workspace/search',
    requestContext,
    state: { trustedRootDefault: root, safeTrustedRoot: safeRootFor(root) },
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /trusted root/i);
});
