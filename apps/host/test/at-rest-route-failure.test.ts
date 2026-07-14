import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AtRestKeyError } from '../src/security/at-rest.js';
import { buildMemorySystemBlockFromStore } from '../src/memory/memory-query.js';
import { readMemorySettings, writeMemorySettings } from '../src/memory/memory-settings.js';
import { memoryOwnerDir } from '../src/memory/memory-owner.js';
import { conversationBufferPath } from '../src/memory/conversation-buffer.js';
import {
  __resetConsolidateTriggerState,
  maybeConsolidatePreviousConversation,
} from '../src/memory/consolidate-trigger.js';
import { createOrchestrationCheckpointStore } from '../src/orchestrator/checkpoint-store.js';
import { handleConversationRoutes } from '../src/routes/conversation-routes.js';
import { recordAgentRun } from '../src/routes/agent-stream-record.js';
import type { AgentEngineRouteState } from '../src/routes/agent-engine-route-support.js';
import { runKimiAndRecord } from '../src/routes/agent-engine-route-records.js';
import { handleRunRoutes } from '../src/routes/run-routes.js';
import { handleSystemRoutes } from '../src/routes/system-routes.js';
import { listRunRecords, writeRunRecord } from '../src/runtime/run-store.js';
import { FileConversationStore } from '../src/storage/conversation-store.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';
import { samePathReal } from './helpers/path-swap.js';

type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener
  | ((chunk: Buffer | string) => void)
  | (() => void)
  | ((error: Error) => void);
type CapturedResponse = HttpResponseLike & {
  status: number;
  body: string;
  write(chunk?: string | Buffer): unknown;
  on(event: string, listener: RequestListener): unknown;
  json(): Record<string, unknown>;
};

class FakeRequest implements HttpRequestLike {
  readonly headers = {};
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(readonly method: string) {}

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
    write() {
      return true;
    },
    on() {
      return this;
    },
    json() {
      return JSON.parse(this.body || '{}') as Record<string, unknown>;
    },
  };
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-at-rest-route-'));
}

function isPathLike(value: unknown): value is string | Buffer | URL {
  return typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL;
}

function patchRead(
  targetPath: string,
  error: AtRestKeyError,
): () => void {
  const original = fs.readFileSync;
  fs.readFileSync = ((filePath: unknown, ...args: unknown[]) => {
    let matches = false;
    if (typeof filePath === 'number') {
      const target = fs.statSync(targetPath);
      const opened = fs.fstatSync(filePath);
      matches = target.dev === opened.dev && target.ino === opened.ino;
    } else if (isPathLike(filePath)) {
      matches = samePathReal(String(filePath), targetPath);
    }
    if (matches) throw error;
    return Reflect.apply(original, fs, [filePath, ...args]);
  }) as typeof fs.readFileSync;
  return () => {
    fs.readFileSync = original;
  };
}

async function captureRejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected action to reject');
}

function checkpoint(runId: string, root: string) {
  return {
    version: 1 as const,
    runId,
    userGoal: 'typed error propagation',
    recipeId: 'test',
    mode: 'workflow' as const,
    status: 'running' as const,
    workspaceRoot: root,
    securityMode: 'local_strict' as const,
    agents: [], refs: [], tasks: [], results: [], completedStepIds: [],
    currentStepId: 'read',
    eventsPath: path.join(root, 'events.jsonl'),
    checkpointPath: '',
    artifacts: [],
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

test('file stores and memory query propagate at-rest key failures', () => {
  const root = tempRoot();
  const keyError = new AtRestKeyError('test key unavailable');
  assert.throws(
    () => buildMemorySystemBlockFromStore({
      readMainMemory: () => { throw keyError; },
      listMemoryNotes: () => [],
      buildMemorySystemBlock: () => '',
    }, root),
    (error) => error === keyError,
  );

  const runRoot = path.join(root, '.AgentCowork', 'runs');
  fs.mkdirSync(runRoot, { recursive: true });
  const runFile = path.join(runRoot, 'run_typed_error.json');
  fs.writeFileSync(runFile, JSON.stringify({ id: 'run_typed_error', status: 'succeeded' }));
  let restore = patchRead(runFile, keyError);
  try {
    assert.throws(() => listRunRecords(runRoot), (error) => error === keyError);
  } finally {
    restore();
  }

  const conversationStore = new FileConversationStore();
  const owner = { tenantId: 'tenant_typed', userId: 'user_typed' };
  conversationStore.save(root, { id: 'conversation-typed', messages: [] }, owner);
  const conversationBase = path.join(root, '.AgentCowork', 'conversations');
  const ownerDirectory = fs.readdirSync(conversationBase)[0];
  assert.ok(ownerDirectory);
  const conversationFile = path.join(conversationBase, ownerDirectory, 'conversation-typed.json');
  restore = patchRead(conversationFile, keyError);
  try {
    assert.throws(() => conversationStore.get(root, 'conversation-typed', owner), (error) => error === keyError);
    assert.throws(() => conversationStore.list(root, owner), (error) => error === keyError);
  } finally {
    restore();
  }

  const checkpointStore = createOrchestrationCheckpointStore({ root: runRoot });
  const savedPath = checkpointStore.save(checkpoint('run_checkpoint_typed', root));
  restore = patchRead(savedPath, keyError);
  try {
    assert.throws(
      () => checkpointStore.save(checkpoint('run_checkpoint_typed', root)),
      (error) => error === keyError,
    );
  } finally {
    restore();
  }
});

test('conversation and run-event routes report at-rest key failures as HTTP 500', async () => {
  const keyError = new AtRestKeyError('route key unavailable');
  const conversationRoot = tempRoot();
  let response = capturedResponse();
  assert.equal(await handleConversationRoutes({
    request: new FakeRequest('GET'),
    response,
    pathname: '/api/conversations/typed-error',
    requestUrl: new URL('http://local/api/conversations/typed-error'),
    requestContext: { tenantId: 'tenant_route', userId: 'user_route', traceId: 'trace_route' },
    trustedRootDefault: conversationRoot,
    safeTrustedRoot: () => conversationRoot,
    conversationStore: {
      list: () => [],
      get: () => { throw keyError; },
      save: () => ({}),
      remove: () => false,
    },
  }), true);
  assert.equal(response.status, 500);
  assert.equal(response.json().code, 'AT_REST_KEY_ERROR');

  const runRoot = path.join(tempRoot(), 'runs');
  fs.mkdirSync(runRoot, { recursive: true });
  const runId = 'run_route_typed';
  const runFile = path.join(runRoot, `${runId}.json`);
  fs.writeFileSync(runFile, JSON.stringify({
    id: runId,
    status: 'succeeded',
    context: { tenantId: 'tenant_route', userId: 'user_route' },
  }));
  const restore = patchRead(runFile, keyError);
  response = capturedResponse();
  try {
    assert.equal(await handleRunRoutes({
      request: new FakeRequest('GET'),
      response,
      pathname: `/api/runs/${runId}/events`,
      requestUrl: new URL(`http://local/api/runs/${runId}/events`),
      requestContext: { tenantId: 'tenant_route', userId: 'user_route', traceId: 'trace_route' },
      runStoreRoot: runRoot,
      runsIndex: { list: () => [], stats: () => ({}) },
      runEvents: { seed: () => undefined, replay: () => [], subscribe: () => () => undefined },
    }), true);
  } finally {
    restore();
  }
  assert.equal(response.status, 500);
  assert.equal(response.json().code, 'AT_REST_KEY_ERROR');
});

test('diagnostic recorders and Kimi routes do not swallow or reclassify at-rest key failures', async () => {
  const root = tempRoot();
  const runId = 'run_record_typed';
  const runPath = path.join(root, `${runId}.json`);
  const keyError = new AtRestKeyError('record key unavailable');
  writeRunRecord(root, {
    id: runId,
    status: 'succeeded',
    context: { tenantId: 'tenant_record', userId: 'user_record' },
  });
  const restoreRead = patchRead(runPath, keyError);
  try {
    assert.throws(() => recordAgentRun({
      runStoreRoot: root,
      runsIndex: { upsert: () => undefined },
      requestContext: { tenantId: 'tenant_record', userId: 'user_record' },
      runId,
      modelConfig: { provider: 'test', model: 'test-model' },
      body: {},
      trustedRoot: root,
      startedAt: new Date('2026-07-11T00:00:00.000Z'),
      status: 'succeeded',
      prompt: 'test',
      outcome: {},
      events: [],
    }), (error) => error === keyError);
  } finally {
    restoreRead();
  }

  const kimiError = new AtRestKeyError('kimi record key unavailable');
  const state = {
    memoryStore: { loadMemoryContext: () => ({ enabled: false, text: '' }) },
    agentModelConfig: {
      provider: 'test', model: 'test-model', baseUrl: 'http://127.0.0.1',
      configured: true, apiKey: 'test-placeholder-key', timeoutMs: 10, maxTokens: 10,
    },
    config: {},
    runStoreRoot: path.join(root, 'kimi-runs'),
    indexRun: () => undefined,
  } as unknown as AgentEngineRouteState;
  assert.equal(await captureRejection(() => runKimiAndRecord({
      state,
      type: 'test',
      mode: 'test',
      trustedRoot: root,
      prompt: 'test',
      runner: async () => { throw kimiError; },
      response: capturedResponse(),
      context: {
        tenantId: 'tenant_kimi', userId: 'user_kimi', traceId: 'trace_kimi',
        authenticated: true, idempotencyKey: 'test-kimi-idempotency',
      },
    })), kimiError);
  assert.equal(kimiError.statusCode, 500);
  assert.equal(fs.existsSync(state.runStoreRoot), false);
});

test('memory settings and system fallback status do not hide at-rest key failures', async () => {
  const root = tempRoot();
  const context = {
    tenantId: 'tenant_memory', userId: 'user_memory', traceId: 'trace_memory',
    authenticated: true, idempotencyKey: 'test-memory-idempotency',
  };
  const previousEncryption = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '0';
  try {
    writeMemorySettings(root, { paused: false }, context);
  } finally {
    if (previousEncryption === undefined) delete process.env.KCW_ENCRYPT_AT_REST;
    else process.env.KCW_ENCRYPT_AT_REST = previousEncryption;
  }

  const keyError = new AtRestKeyError('settings key unavailable');
  const restore = patchRead(
    path.join(memoryOwnerDir(root, context), 'memory-settings.json'),
    keyError,
  );
  try {
    assert.throws(() => readMemorySettings(root, context), (error) => error === keyError);
    assert.equal(await captureRejection(() => handleSystemRoutes({
      request: new FakeRequest('GET'),
      response: capturedResponse(),
      pathname: '/api/fallback/status',
      requestUrl: new URL('http://local/api/fallback/status'),
      requestContext: context,
      state: {
        agentConcurrency: { stats: () => ({ active: 0, maxConcurrent: 1, tenants: 0 }) },
        agentModelConfig: { configured: false, apiKey: '', provider: 'test', baseUrl: '', model: '' },
        config: { runtimeDependencyEnv: {} },
        trustedRootDefault: root,
        cancellation: { cancel: () => false },
        globalMutationAdmins: [],
      },
    })), keyError);
  } finally {
    restore();
  }
});

test('lazy memory consolidation preserves an at-rest key rejection', async () => {
  __resetConsolidateTriggerState();
  const root = tempRoot();
  const owner = { tenantId: 'tenant_consolidate', userId: 'user_consolidate' };
  const buffer = conversationBufferPath(root, 'conversation-key-error', owner);
  fs.mkdirSync(path.dirname(buffer), { recursive: true });
  fs.writeFileSync(buffer, `${JSON.stringify({
    role: 'user', text: 'test turn', ts: '2026-07-11T00:00:00.000Z',
  })}\n`);
  const common = {
    trustedRoot: root,
    tenantId: owner.tenantId,
    userId: owner.userId,
    modelConfig: {},
    callJson: async () => [],
    minTurns: 1,
  };
  await maybeConsolidatePreviousConversation({
    ...common,
    conversationId: 'conversation-key-error',
  }).done;

  const keyError = new AtRestKeyError('consolidation key unavailable');
  const restore = patchRead(buffer, keyError);
  try {
    const { done } = maybeConsolidatePreviousConversation({
      ...common,
      conversationId: 'conversation-next',
    });
    assert.equal(await captureRejection(() => done), keyError);
  } finally {
    restore();
    __resetConsolidateTriggerState();
  }
});
