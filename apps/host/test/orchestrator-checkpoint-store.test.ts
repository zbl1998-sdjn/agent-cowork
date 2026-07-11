import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrchestrationCheckpointStore } from '../src/orchestrator/checkpoint-store.js';
import { AtRestKeyError } from '../src/security/at-rest.js';
import type { OrchestrationCheckpoint } from '../src/orchestrator/types.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-checkpoint-store-'));
}

function baseCheckpoint(overrides: Partial<OrchestrationCheckpoint> = {}): OrchestrationCheckpoint {
  return {
    version: 1,
    runId: 'run_checkpoint_store_test',
    userGoal: 'Create a weekly report',
    recipeId: 'weekly-report',
    mode: 'workflow',
    status: 'running',
    workspaceRoot: '',
    securityMode: 'local_strict',
    agents: ['researcher'],
    refs: [],
    tasks: [],
    results: [],
    completedStepIds: [],
    currentStepId: 'research',
    eventsPath: '',
    checkpointPath: '',
    artifacts: [],
    startedAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

test('checkpoint store preserves workspaceRoot/eventsPath containing AppData segments verbatim', () => {
  const root = tempRoot();
  // Build paths that explicitly carry an "AppData" segment on any host OS (on real
  // Windows this app's data root is %APPDATA%\AgentCowork; CI runs on Linux where the
  // temp dir is /tmp, so we can't rely on the OS temp path containing it). The redaction
  // pass on save() must never mangle these structural path fields.
  const runStoreRoot = path.join(root, 'AppData', 'Local', 'AgentCowork', 'runs');
  const workspaceRoot = path.join(root, 'AppData', 'Local', 'workspace');
  const eventsPath = path.join(runStoreRoot, 'run_checkpoint_store_test.events.jsonl');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  assert.match(workspaceRoot, /[\\/]AppData[\\/]/i);

  const store = createOrchestrationCheckpointStore({ root: runStoreRoot });
  store.save(baseCheckpoint({ workspaceRoot, eventsPath }));

  const loaded = store.load('run_checkpoint_store_test');
  assert.ok(loaded, 'checkpoint should be readable back');
  assert.equal(loaded?.workspaceRoot, workspaceRoot);
  assert.equal(loaded?.eventsPath, eventsPath);
});

test('checkpoint store still redacts credential-shaped free text in user-supplied fields', () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const store = createOrchestrationCheckpointStore({ root: runStoreRoot });
  store.save(baseCheckpoint({
    runId: 'run_checkpoint_secret_test',
    workspaceRoot: root,
    userGoal: 'Use api_key=sk-test-dummy-0000000000 to call the service', // allowlist-secret
    refs: [{
      refId: 'note',
      kind: 'file',
      label: 'note.md',
      dataTags: ['internal'],
      text: 'password=hunter2-not-a-real-secret', // allowlist-secret
      summary: '',
      uri: 'file:///note.md',
      metadata: {},
    }],
  }));

  const loaded = store.load('run_checkpoint_secret_test');
  assert.ok(loaded, 'checkpoint should be readable back');
  assert.equal(loaded?.userGoal.includes('sk-test-dummy-0000000000'), false);
  assert.equal(loaded?.refs[0]?.text.includes('hunter2-not-a-real-secret'), false);
});

test('checkpoint save refuses to overwrite an undecryptable or malformed existing record', () => {
  const root = tempRoot();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const store = createOrchestrationCheckpointStore({ root: runStoreRoot });
  for (const scenario of [
    { runId: 'run_checkpoint_bad_cipher', raw: 'aesgcm:v1:AAAA:BBBB:CCCC' },
    { runId: 'run_checkpoint_bad_json', raw: '{"version":1,' },
  ]) {
    const checkpoint = baseCheckpoint({ runId: scenario.runId });
    const checkpointFile = path.join(
      runStoreRoot,
      'orchestrator-checkpoints',
      `${scenario.runId}.json`,
    );
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.writeFileSync(checkpointFile, scenario.raw, 'utf8');
    const before = fs.readFileSync(checkpointFile);

    assert.throws(
      () => store.save(checkpoint),
      (error: unknown) => scenario.runId.endsWith('bad_cipher')
        ? error instanceof AtRestKeyError
        : /checkpoint.*corrupt|decrypt|verified/i.test(String(error)),
    );
    assert.deepEqual(fs.readFileSync(checkpointFile), before);
  }
});

test('checkpoint save refuses incomplete or mismatched persisted state without changing bytes', () => {
  for (const scenario of [
    {
      requestedRunId: 'run_checkpoint_incomplete',
      persisted: { runId: 'run_checkpoint_incomplete' },
    },
    {
      requestedRunId: 'run_checkpoint_mismatched',
      persisted: baseCheckpoint({ runId: 'run_checkpoint_other' }),
    },
  ]) {
    const root = tempRoot();
    const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
    const checkpointFile = path.join(
      runStoreRoot,
      'orchestrator-checkpoints',
      `${scenario.requestedRunId}.json`,
    );
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
    fs.writeFileSync(checkpointFile, `${JSON.stringify(scenario.persisted)}\n`, 'utf8');
    const before = fs.readFileSync(checkpointFile);
    const store = createOrchestrationCheckpointStore({ root: runStoreRoot });

    assert.throws(
      () => store.save(baseCheckpoint({ runId: scenario.requestedRunId })),
      /checkpoint.*corrupt|verified|runId/i,
    );
    assert.deepEqual(fs.readFileSync(checkpointFile), before);
  }
});
