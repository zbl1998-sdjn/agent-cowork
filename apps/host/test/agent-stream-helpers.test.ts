import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBudgetGuard, resolveAgentRunTimeoutMs } from '../src/routes/agent-stream-budget.js';
import { buildAgentConfigSnapshot } from '../src/routes/agent-config-snapshot.js';
import { resolveAgentRunStart } from '../src/routes/agent-resume.js';
import { cancelApprovalsForDisconnectedRun, streamAgentChat } from '../src/routes/agent-stream.js';
import { sanitizeAgentEventData } from '../src/routes/agent-stream-events.js';
import { recordAgentRun } from '../src/routes/agent-stream-record.js';
import type { RunsIndexLike } from '../src/routes/agent-stream-record.js';
import { readRunRecord } from '../src/runtime/run-store.js';
import { present, recordValue, stringField, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';

function tmp(): string {
  return tempRoot('kcw-agent-stream-');
}

class CapturingAgentResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    this.headers = { ...headers };
  }

  write(chunk: string | Buffer = ''): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk: string | Buffer = ''): void {
    if (chunk) this.write(chunk);
    this.ended = true;
  }

  on(event: string, listener: () => void): this {
    const existing = this.listeners.get(event) || [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emitClose(): void {
    for (const listener of this.listeners.get('close') || []) listener();
  }

  text(): string {
    return this.chunks.join('');
  }
}

function ssePayload(streamText: string, event: string): Record<string, unknown> {
  const marker = `event: ${event}\ndata: `;
  const index = streamText.indexOf(marker);
  assert.ok(index >= 0, `stream should include ${event} event`);
  const line = streamText.slice(index + marker.length).split('\n')[0] || '{}';
  return recordValue(JSON.parse(line), `${event} event`);
}

function requestContext(): { tenantId: string; userId: string; traceId: string } {
  return { tenantId: 'tenant_agent_stream', userId: 'user_agent_stream', traceId: 'trace_agent_stream' };
}

function captureRunsIndex(): { runsIndex: RunsIndexLike; summaries: unknown[] } {
  const summaries: unknown[] = [];
  return {
    summaries,
    runsIndex: {
      upsert(summary: unknown) {
        summaries.push(summary);
      },
    },
  };
}

test('agent stream budget helpers ignore non-positive limits and choose the tightest valid limit', () => {
  const body = {
    maxRunTokens: 25,
    maxWallClockMs: 0,
    budget: { maxRunTokens: 12, maxSessionTokens: -2, maxWallClockMs: 500 },
  };
  const config = { maxRunTokens: 20, maxSessionTokens: 30, maxAgentWallClockMs: 1_000, model: 'fake' };

  assert.equal(resolveAgentRunTimeoutMs(body, config), 500);

  const guard = createAgentBudgetGuard({
    body,
    modelConfig: config,
    startedAt: new Date(),
    runTimeoutMs: undefined,
  });
  const tokenDecision = guard.recordUsage({ prompt_tokens: 6, completion_tokens: 7, total_tokens: 13 });
  assert.equal(tokenDecision.shouldAbort, true);
  assert.equal(tokenDecision.limit, 'maxRunTokens');
  assert.equal(tokenDecision.maximum, 12);
});

test('agent stream budget helpers reject malformed budget fields', () => {
  assert.throws(
    () => resolveAgentRunTimeoutMs({ budget: { maxWallClockMs: ['bad'] } }, {}),
    /agent stream budget: budget\.maxWallClockMs:/,
  );
});

test('agent config snapshot normalizes diagnostics without leaking fallback keys', () => {
  const snapshot = buildAgentConfigSnapshot(
    { mode: 'developer', thinking: 'deep', maxSteps: '99', permissionMode: 'guarded_auto' },
    {
      provider: 'openai',
      temperature: '0.25',
      fallbacks: [
        { provider: 'openai/local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: 'test-local-key' },
        'malformed-fallback',
      ],
    },
  );

  assert.equal(snapshot.developerMode, true);
  assert.equal(snapshot.permissionMode, 'guarded_auto');
  assert.equal(snapshot.verify, true);
  assert.equal(snapshot.maxSteps, 40);
  assert.equal(snapshot.temperature, 0.25);
  const firstFallback = present(snapshot.fallbacks[0], 'first fallback');
  const secondFallback = present(snapshot.fallbacks[1], 'second fallback');
  assert.equal(firstFallback.hasKey, true);
  assert.equal(Object.hasOwn(firstFallback, 'apiKey'), false);
  assert.equal(secondFallback.hasKey, false);
});

test('agent config snapshot normalizes legacy permission flags and keeps unknown modes fail-closed', () => {
  assert.equal(buildAgentConfigSnapshot({ autoApprove: true }, {}).permissionMode, 'guarded_auto');
  const legacyPlan = buildAgentConfigSnapshot({ autoApprove: true, planMode: true }, {});
  assert.equal(legacyPlan.permissionMode, 'plan');
  assert.equal(legacyPlan.planMode, true);

  const explicitPlan = buildAgentConfigSnapshot({ permissionMode: 'plan' }, {});
  assert.equal(explicitPlan.permissionMode, 'plan');
  assert.equal(explicitPlan.planMode, true);

  const unknown = buildAgentConfigSnapshot({ permissionMode: 'invalid', planMode: true }, {});
  assert.equal(unknown.permissionMode, 'manual');
  assert.equal(unknown.planMode, false);
});

test('agent resume helper trims resume ids and keeps seeded ids deterministic', () => {
  const resumed = resolveAgentRunStart({
    body: { resumeRunId: ' run_resume_123 ' },
    runStoreRoot: null,
    requestContext: requestContext(),
  });
  assert.equal(resumed.runId, 'run_resume_123');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.checkpointer, null);
  assert.equal(resumed.resumeState, null);

  const seededA = resolveAgentRunStart({
    body: { resumeRunId: ['ignored'], runSeed: ' fixed-seed ' },
    runStoreRoot: null,
    requestContext: requestContext(),
  });
  const seededB = resolveAgentRunStart({
    body: { runSeed: 'fixed-seed' },
    runStoreRoot: null,
    requestContext: requestContext(),
  });
  assert.equal(seededA.resumed, false);
  assert.equal(seededA.runId, seededB.runId);
  assert.equal(seededA.startedAt.toISOString(), seededB.startedAt.toISOString());
});

test('recordAgentRun normalizes provider, writes index summary, and swallows record failures', () => {
  const runStoreRoot = tmp();
  const summaries: unknown[] = [];
  const runsIndex: RunsIndexLike = { upsert: (summary) => summaries.push(summary) };

  recordAgentRun({
    runStoreRoot,
    runsIndex,
    requestContext: { tenantId: 't1', userId: 'u1' },
    runId: 'run_agent_stream_helper',
    modelConfig: { provider: '  OpenAI-Compatible ', model: 'test-model' },
    body: { prompt: 'hello', maxSteps: 2 },
    trustedRoot: runStoreRoot,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'succeeded',
    prompt: 'hello',
    outcome: { text: 'done', steps: [{ tool: 'Read', args: { apiKey: 'dummy-step-secret' } }], usage: { total_tokens: 3 } },
    events: [{ type: 'done', metadata: { authorization: 'Bearer dummy-event-secret' } }],
  });

  const record = readRunRecord(runStoreRoot, 'run_agent_stream_helper');
  const savedRecord = present(record, 'saved run record');
  assert.equal(savedRecord.provider, 'openai-compatible');
  const result = recordValue(savedRecord.result, 'saved run result');
  assert.equal(stringField(result, 'text'), 'done');
  assert.equal(JSON.stringify(savedRecord).includes('dummy-step-secret'), false);
  assert.equal(JSON.stringify(savedRecord).includes('dummy-event-secret'), false);
  assert.match(JSON.stringify(savedRecord), /REDACTED/);
  assert.equal(summaries.length, 1);
  const summary = recordValue(present(summaries[0], 'index summary'), 'index summary');
  assert.equal(stringField(summary, 'provider'), 'openai-compatible');

  assert.doesNotThrow(() => recordAgentRun({
    runStoreRoot: '',
    runsIndex,
    requestContext: {},
    runId: '../bad',
    modelConfig: {},
    body: {},
    trustedRoot: runStoreRoot,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'failed',
    prompt: '',
    outcome: {},
    events: [],
  }));

  assert.doesNotThrow(() => recordAgentRun({
    runStoreRoot,
    runsIndex,
    requestContext: {},
    runId: 'run_invalid_started_at',
    modelConfig: {},
    body: {},
    trustedRoot: runStoreRoot,
    startedAt: 'not-a-date',
    status: 'failed',
    prompt: '',
    outcome: {},
    events: [],
  }));
});

test('agent stream event sanitization redacts secrets before SSE and run capture', () => {
  const sanitized = sanitizeAgentEventData({
    name: 'Shell',
    args: {
      command: 'echo safe',
      apiKey: 'dummy-api-secret',
      nested: { Authorization: 'Bearer dummy-auth-secret' },
    },
  });

  assert.equal(JSON.stringify(sanitized).includes('dummy-api-secret'), false);
  assert.equal(JSON.stringify(sanitized).includes('dummy-auth-secret'), false);
  assert.equal(recordValue(recordValue(sanitized.args, 'args').nested, 'nested').Authorization, '[REDACTED]');
});

test('streamAgentChat returns 404 for a missing resume checkpoint without recording a run', async () => {
  const root = tmp();
  const response = new CapturingAgentResponse();
  const { runsIndex, summaries } = captureRunsIndex();

  await streamAgentChat({
    response,
    requestContext: requestContext(),
    body: { resumeRunId: ' run_missing_checkpoint ' },
    modelConfig: { provider: 'test-provider', model: 'test-model' },
    trustedRoot: root,
    runStoreRoot: root,
    runsIndex,
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.ended, true);
  const body = recordValue(JSON.parse(response.text()), 'missing resume response');
  assert.equal(body.runId, 'run_missing_checkpoint');
  assert.match(stringField(body, 'error'), /检查点/);
  assert.equal(summaries.length, 0);
});

test('streamAgentChat cancels runs and pending approvals when the client disconnects', async () => {
  const root = tmp();
  const response = new CapturingAgentResponse();
  const { runsIndex, summaries } = captureRunsIndex();
  const controller = new AbortController();
  const cancelled: string[] = [];
  const done: string[] = [];
  const cancellationContexts: unknown[] = [];
  const approvalCancels: Array<{ runId: string; context: unknown }> = [];

  await streamAgentChat({
    response,
    requestContext: requestContext(),
    body: { prompt: 'cancel me', runSeed: 'agent-stream-cancel-seed' },
    modelConfig: { ...TEST_LOCAL_MODEL_CONFIG, model: 'test-model', timeoutMs: 1000 },
    trustedRoot: root,
    runStoreRoot: root,
    runsIndex,
    cancellation: {
      register(_runId: string, context?: unknown) {
        cancellationContexts.push(context);
        return { signal: controller.signal };
      },
      cancel(runId: string, _reason?: string, context?: unknown) {
        cancelled.push(runId);
        cancellationContexts.push(context);
        controller.abort(new Error('client disconnected'));
      },
      done(runId: string, context?: unknown) {
        done.push(runId);
        cancellationContexts.push(context);
      },
    },
    approvals: {
      request() {
        throw new Error('approval request should not be reached');
      },
      cancelByRun(runId: string, context?: unknown) {
        approvalCancels.push({ runId, context });
      },
    },
    modelCall: async (args: Record<string, unknown>) => {
      response.emitClose();
      const signal = args.signal as AbortSignal;
      assert.equal(signal.aborted, true);
      return { content: 'partial answer after disconnect', usage: { total_tokens: 2 } };
    },
  });

  const streamText = response.text();
  const start = ssePayload(streamText, 'start');
  const runId = stringField(start, 'runId');
  assert.deepEqual(cancelled, [runId]);
  assert.deepEqual(cancellationContexts, [requestContext(), requestContext(), requestContext()]);
  assert.deepEqual(approvalCancels, [{ runId, context: requestContext() }]);
  assert.deepEqual(done, [runId]);
  assert.equal(ssePayload(streamText, 'cancelled').runId, runId);
  assert.equal(streamText.includes('event: done'), false);
  assert.equal(summaries.length, 2, 'start writes a running summary, completion overwrites it');
  assert.equal(recordValue(present(summaries[0], 'start summary'), 'start summary').status, 'running');
  const record = recordValue(present(readRunRecord(root, runId), 'cancelled run record'), 'cancelled run record');
  assert.equal(record.status, 'cancelled');
});

test('disconnect approval cleanup reports synchronous and asynchronous failures without rejecting', async () => {
  const errors: string[] = [];
  const request = () => ({ id: 'unused', promise: Promise.resolve('reject') });

  assert.doesNotThrow(() => cancelApprovalsForDisconnectedRun({
    request,
    cancelByRun: () => { throw new Error('synchronous cleanup failure'); },
  }, 'run_sync_failure', requestContext(), (message) => errors.push(message)));

  assert.doesNotThrow(() => cancelApprovalsForDisconnectedRun({
    request,
    cancelByRun: async () => { throw new Error('asynchronous cleanup failure'); },
  }, 'run_async_failure', requestContext(), (message) => errors.push(message)));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, [
    'synchronous cleanup failure',
    'asynchronous cleanup failure',
  ]);
});

test('streamAgentChat emits safe error events and still records failed runs', async () => {
  const root = tmp();
  const response = new CapturingAgentResponse();
  const { runsIndex, summaries } = captureRunsIndex();

  await streamAgentChat({
    response,
    requestContext: requestContext(),
    body: { prompt: 'fail me', runSeed: 'agent-stream-failure-seed' },
    modelConfig: { ...TEST_LOCAL_MODEL_CONFIG, model: 'test-model', timeoutMs: 1000 },
    trustedRoot: root,
    runStoreRoot: root,
    runsIndex,
    modelCall: async () => {
      throw new Error('model exploded with dummy-secret');
    },
  });

  const streamText = response.text();
  const runId = stringField(ssePayload(streamText, 'start'), 'runId');
  const error = ssePayload(streamText, 'error');
  assert.match(stringField(error, 'error'), /model exploded/);
  assert.match(stringField(error, 'error'), /trace_agent_stream/);
  assert.equal(error.runId, runId);
  assert.equal(response.ended, true);
  assert.equal(summaries.length, 2, 'start writes a running summary, completion overwrites it');
  assert.equal(recordValue(present(summaries[0], 'start summary'), 'start summary').status, 'running');
  const record = recordValue(present(readRunRecord(root, runId), 'failed run record'), 'failed run record');
  assert.equal(record.status, 'failed');
});
