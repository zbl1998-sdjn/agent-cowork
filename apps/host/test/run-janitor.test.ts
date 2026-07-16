import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INTERRUPTED_RUN_ERROR, markInterruptedRuns } from '../src/runtime/run-janitor.js';
import { readRunRecord, writeRunRecord } from '../src/runtime/run-store.js';
import { createRunsIndex, summariseRunForIndex } from '../src/runtime/runs-index.js';
import { taskFromRun } from '../src/runtime/task-presenter.js';

function makeStore(): { runStoreRoot: string; runsIndex: ReturnType<typeof createRunsIndex> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acw-janitor-'));
  return { runStoreRoot: root, runsIndex: createRunsIndex({ indexRoot: path.join(root, 'index') }) };
}

const OWNER = { tenantId: 'tenant-a', userId: 'user-a' };

function seedRun(store: ReturnType<typeof makeStore>, id: string, status: string): void {
  const record = { id, type: 'agent-chat', status, startedAt: '2026-07-17T00:00:00.000Z', context: OWNER, input: { prompt: '测试' } };
  const runPath = writeRunRecord(store.runStoreRoot, record);
  store.runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, OWNER), OWNER);
}

test('markInterruptedRuns flips stale running records and leaves other statuses alone', async () => {
  const store = makeStore();
  seedRun(store, 'run_stale', 'running');
  seedRun(store, 'run_done', 'succeeded');
  seedRun(store, 'run_pending', 'awaiting_approval');

  const marked = await markInterruptedRuns({ ...store, now: new Date('2026-07-17T01:00:00.000Z') });
  assert.deepEqual(marked, ['run_stale']);

  const stale = readRunRecord(store.runStoreRoot, 'run_stale') as Record<string, unknown>;
  assert.equal(stale.status, 'interrupted');
  assert.equal(stale.error, INTERRUPTED_RUN_ERROR);
  assert.equal(stale.durationMs, 60 * 60 * 1000);
  assert.equal((readRunRecord(store.runStoreRoot, 'run_done') as Record<string, unknown>).status, 'succeeded');
  assert.equal((readRunRecord(store.runStoreRoot, 'run_pending') as Record<string, unknown>).status, 'awaiting_approval');

  const listed = store.runsIndex.list({ limit: 10 }) as Array<{ id: string; status: string }>;
  assert.equal(listed.find((r) => r.id === 'run_stale')?.status, 'interrupted');
  assert.equal(store.runsIndex.list({ status: 'running', limit: 10 }).length, 0);

  assert.deepEqual(await markInterruptedRuns(store), [], 'second sweep finds nothing');
});

test('interrupted runs present as failed tasks with the interruption error', () => {
  const task = taskFromRun({ id: 'run_stale', status: 'interrupted', error: INTERRUPTED_RUN_ERROR });
  assert.equal(task.status, 'failed');
  assert.equal(task.error, INTERRUPTED_RUN_ERROR);
});
