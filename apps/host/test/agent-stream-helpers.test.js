import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentBudgetGuard, resolveAgentRunTimeoutMs } from '../src/routes/agent-stream-budget.js';
import { buildAgentConfigSnapshot } from '../src/routes/agent-config-snapshot.js';
import { resolveAgentRunStart } from '../src/routes/agent-resume.js';
import { recordAgentRun } from '../src/routes/agent-stream-record.js';
import { readRunRecord } from '../src/runtime/run-store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-agent-stream-')); }

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
    kimiConfig: config,
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
    { mode: 'developer', thinking: 'deep', maxSteps: '99' },
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
  assert.equal(snapshot.verify, true);
  assert.equal(snapshot.maxSteps, 16);
  assert.equal(snapshot.temperature, 0.25);
  assert.equal(snapshot.fallbacks[0].hasKey, true);
  assert.equal(Object.hasOwn(snapshot.fallbacks[0], 'apiKey'), false);
  assert.equal(snapshot.fallbacks[1].hasKey, false);
});

test('agent resume helper trims resume ids and keeps seeded ids deterministic', () => {
  const resumed = resolveAgentRunStart({ body: { resumeRunId: ' run_resume_123 ' }, runStoreRoot: null });
  assert.equal(resumed.runId, 'run_resume_123');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.checkpointer, null);
  assert.equal(resumed.resumeState, null);

  const seededA = resolveAgentRunStart({ body: { resumeRunId: ['ignored'], runSeed: ' fixed-seed ' }, runStoreRoot: null });
  const seededB = resolveAgentRunStart({ body: { runSeed: 'fixed-seed' }, runStoreRoot: null });
  assert.equal(seededA.resumed, false);
  assert.equal(seededA.runId, seededB.runId);
  assert.equal(seededA.startedAt.toISOString(), seededB.startedAt.toISOString());
});

test('recordAgentRun normalizes provider, writes index summary, and swallows record failures', () => {
  const runStoreRoot = tmp();
  const summaries = [];
  const runsIndex = { upsert: (summary) => summaries.push(summary) };

  recordAgentRun({
    runStoreRoot,
    runsIndex,
    requestContext: { tenantId: 't1', userId: 'u1' },
    runId: 'run_agent_stream_helper',
    kimiConfig: { provider: '  OpenAI-Compatible ', model: 'test-model' },
    body: { prompt: 'hello', maxSteps: 2 },
    trustedRoot: runStoreRoot,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'succeeded',
    prompt: 'hello',
    outcome: { text: 'done', steps: [{ tool: 'Read' }], usage: { total_tokens: 3 } },
    events: [{ type: 'done' }],
  });

  const record = readRunRecord(runStoreRoot, 'run_agent_stream_helper');
  assert.equal(record.provider, 'openai-compatible');
  assert.equal(record.result.text, 'done');
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].provider, 'openai-compatible');

  assert.doesNotThrow(() => recordAgentRun({
    runStoreRoot: '',
    runsIndex,
    requestContext: {},
    runId: '../bad',
    kimiConfig: {},
    body: {},
    trustedRoot: runStoreRoot,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    status: 'failed',
    prompt: '',
    outcome: {},
    events: [],
  }));
});
