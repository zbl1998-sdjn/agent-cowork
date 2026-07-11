import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { RunsIndex } from '../src/runtime/runs-index.js';
import { writeRunRecord } from '../src/runtime/run-store.js';
import { createServer } from '../src/server.js';
import { arrayField, bind, close, jsonRequest, objectField, tempRoot } from './helpers/host-http.js';

const tenantId = 'tenant_shared';
const alice = { 'x-tenant-id': tenantId, 'x-user-id': 'user_alice' };
const bob = { 'x-tenant-id': tenantId, 'x-user-id': 'user_bob' };

function runRecord(id: string, userId: string, prompt: string) {
  return {
    id,
    tenantId,
    userId,
    type: 'agent-chat',
    status: 'succeeded',
    startedAt: `2026-07-10T00:00:0${userId === 'user_alice' ? '1' : '2'}.000Z`,
    context: { tenantId, userId },
    input: { prompt },
    events: [{ seq: 1, ts: '2026-07-10T00:00:00.000Z', type: 'secret', prompt }],
  };
}

test('run history, detail, events, index, and stats are isolated by exact tenant and user', async () => {
  const root = tempRoot('kcw-run-user-scope-');
  const runStoreRoot = path.join(root, 'runs');
  const runsIndex = new RunsIndex({ indexRoot: path.join(root, 'run-index') });
  const aliceRun = runRecord('run_alice_private', 'user_alice', 'alice secret');
  const bobRun = runRecord('run_bob_private', 'user_bob', 'bob secret');
  writeRunRecord(runStoreRoot, aliceRun);
  writeRunRecord(runStoreRoot, bobRun);
  runsIndex.upsert(aliceRun);
  runsIndex.upsert(bobRun);

  const server = createServer({
    trustedRoot: root,
    runStoreRoot,
    runsIndex,
    trustIdentityHeaders: true,
    enableScheduler: false,
  });
  const base = await bind(server);
  try {
    const list = await jsonRequest(base, '/api/runs', { headers: alice });
    assert.deepEqual(arrayField(list.body, 'runs').map((run) => run.id), ['run_alice_private']);

    const tasks = await jsonRequest(base, '/api/tasks', { headers: alice });
    assert.equal(arrayField(tasks.body, 'tasks').length, 1);

    const siblingDetail = await jsonRequest(base, '/api/runs/run_bob_private', { headers: alice });
    assert.equal(siblingDetail.status, 404);
    const siblingEvents = await jsonRequest(base, '/api/runs/run_bob_private/events', { headers: alice });
    assert.equal(siblingEvents.status, 404);

    const index = await jsonRequest(base, '/api/runs/index?userId=user_bob', { headers: alice });
    assert.deepEqual(arrayField(index.body, 'runs').map((run) => run.id), ['run_alice_private']);
    assert.equal(objectField(index.body, 'stats').total, 1);

    const bobIndex = await jsonRequest(base, '/api/runs/index', { headers: bob });
    assert.deepEqual(arrayField(bobIndex.body, 'runs').map((run) => run.id), ['run_bob_private']);
    assert.equal(objectField(bobIndex.body, 'stats').total, 1);
  } finally {
    await close(server);
  }
});
