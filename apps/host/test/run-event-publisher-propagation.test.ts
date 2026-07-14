import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { runRecipe } from '../src/recipes/run-recipe.js';
import { runCode } from '../src/sandbox/code-runner.js';
import { createServer } from '../src/server.js';
import { RunEventBus } from '../src/runtime/run-events.js';
import { createRunTrace } from '../src/runtime/run-trace.js';
import { runSubagentsParallel } from '../src/runtime/subagent-parallel.js';
import { runSubagent } from '../src/runtime/subagent.js';
import { noopKimiChatRunner, readAgentStream, startRunId } from './helpers/agent-stream.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

const USER_SCOPE = { tenantId: 'tenant_scope_test', userId: 'user_scope_test' };

function assertOnlyScopedEvents(
  bus: RunEventBus,
  runId: string,
  expectedCount: number,
  scope = USER_SCOPE,
): void {
  assert.equal(bus.replay(runId, 0, scope).length, expectedCount);
  assert.deepEqual(bus.replay(runId), [], 'non-local events must not fall into the legacy local key');
}

test('recipe and code producers bind their persisted run context to event publishing', async () => {
  const trustedRoot = tempRoot('kcw-event-producer-');
  const runStoreRoot = path.join(trustedRoot, '.runs');
  const bus = new RunEventBus();

  const recipe = await runRecipe({
    recipeId: 'email-draft',
    trustedRoot,
    prompt: 'draft a scoped email',
    context: USER_SCOPE,
    runStoreRoot,
    runEvents: bus,
  });
  assertOnlyScopedEvents(bus, recipe.runId, recipe.events.length);

  const code = await runCode({
    sandbox: {
      backend: 'vm:test',
      exec: async () => ({ backend: 'vm:test', exitCode: 0, stdout: 'ok' }),
    },
    sandboxLimits: { allowTools: ['node'] },
    tool: 'node',
    code: 'process.stdout.write("ok")',
    trustedRoot,
    context: USER_SCOPE,
    runStoreRoot,
    runEvents: bus,
  });
  assertOnlyScopedEvents(bus, code.runId, code.events.length);
});

test('single and parallel subagent producers bind parent and child events to user scope', async () => {
  const trustedRoot = tempRoot('kcw-event-subagent-');
  const runStoreRoot = path.join(trustedRoot, '.runs');
  const bus = new RunEventBus();
  const registry = {
    has: (name: string) => name === 'safe.read',
    call: async () => ({ content: [{ text: 'grounded result' }] }),
  };

  const single = await runSubagent({
    goal: 'single scoped child',
    steps: [{ tool: 'safe.read' }],
    registry,
    trustedRoot,
    runStoreRoot,
    runEvents: bus,
    context: USER_SCOPE,
  });
  assertOnlyScopedEvents(bus, single.runId, single.events.length);

  const parallel = await runSubagentsParallel({
    goal: 'parallel scoped children',
    agents: [{ goal: 'child one', steps: [{ tool: 'safe.read' }] }],
    registry,
    trustedRoot,
    runStoreRoot,
    runEvents: bus,
    context: USER_SCOPE,
    maxConcurrency: 1,
  });
  assertOnlyScopedEvents(bus, parallel.runId, parallel.events.length);
  const childRunId = parallel.children[0]?.runId;
  assert.ok(childRunId);
  assert.ok(bus.replay(childRunId, 0, USER_SCOPE).length > 0);
  assert.deepEqual(bus.replay(childRunId), []);
});

test('run trace binds its publisher to the agent request context', () => {
  const bus = new RunEventBus();
  const runId = 'run_scoped_trace';
  const trace = createRunTrace({ runId, runEvents: bus, context: USER_SCOPE });
  trace.append({ kind: 'model_context', messages: [] });
  assertOnlyScopedEvents(bus, runId, 1);
});

test('agent HTTP entry binds run-trace events to the authenticated request scope', async () => {
  const trustedRoot = tempRoot('kcw-event-agent-route-');
  const bus = new RunEventBus();
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    trustedRoot,
    requireAuth: false,
    trustIdentityHeaders: true,
    enableScheduler: false,
    modelChatRunner: noopKimiChatRunner,
    agentModelCall: async () => ({ content: 'scoped agent result' }),
    runEventBus: bus as never,
  });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': USER_SCOPE.tenantId,
        'x-user-id': USER_SCOPE.userId,
      },
      body: JSON.stringify({ prompt: 'publish a scoped trace' }),
    });
    assert.equal(response.status, 200);
    const stream = await readAgentStream(response);
    const runId = startRunId(stream);
    assert.ok(bus.replay(runId, 0, USER_SCOPE).length > 0);
    assert.deepEqual(bus.replay(runId), []);
  } finally {
    await close(server);
  }
});

test('direct sandbox HTTP publishing stays inside the authenticated request scope', async () => {
  const trustedRoot = tempRoot('kcw-event-sandbox-route-');
  const bus = new RunEventBus();
  const server = createServer({
    trustedRoot,
    requireAuth: false,
    trustIdentityHeaders: true,
    enableScheduler: false,
    allowUnsafeDirectSandboxRoutes: true,
    runEventBus: bus as never,
    sandbox: {
      backend: 'vm:test',
      networkIsolated: true,
      exec: async () => ({ backend: 'vm:test', exitCode: 0, stdout: 'ok' }),
    },
  });
  const base = await bind(server);
  try {
    const response = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      headers: {
        'x-tenant-id': USER_SCOPE.tenantId,
        'x-user-id': USER_SCOPE.userId,
        'idempotency-key': 'scoped-sandbox-event',
      },
      body: { spec: { tool: 'node', args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 5000 } },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const runId = stringField(response.body, 'runId', 'sandbox scoped run id');
    assertOnlyScopedEvents(bus, runId, 2);
  } finally {
    await close(server);
  }
});
