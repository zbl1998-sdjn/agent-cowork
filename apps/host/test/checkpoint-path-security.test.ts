import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOrchestrationCheckpointStore } from '../src/orchestrator/checkpoint-store.js';
import type { OrchestrationCheckpoint } from '../src/orchestrator/types.js';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { samePathReal } from './helpers/path-swap.js';

type SymlinkSync = (target: string, linkPath: string, type?: 'file' | 'dir' | 'junction') => void;
const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function tempRoot(prefix = 'kcw-checkpoint-path-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

function runCheckpoint(runId: string): Record<string, unknown> {
  return {
    version: 2,
    runId,
    owner: { tenantId: 'tenant_local', userId: 'user_local' },
    step: 1,
    phase: 'running',
    updatedAt: '2026-07-11T00:00:00.000Z',
    messages: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    approvedTools: [],
    todos: [],
    metadata: {},
  };
}

function orchestrationCheckpoint(runId: string, root: string): OrchestrationCheckpoint {
  return {
    version: 1,
    runId,
    userGoal: 'secure checkpoint',
    recipeId: 'weekly-report',
    mode: 'workflow',
    status: 'running',
    workspaceRoot: root,
    securityMode: 'local_strict',
    agents: [],
    refs: [],
    tasks: [],
    results: [],
    completedStepIds: [],
    currentStepId: 'start',
    eventsPath: path.join(root, `${runId}.events.jsonl`),
    checkpointPath: '',
    artifacts: [],
    startedAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };
}

test('RunCheckpointer save, load, and clear reject a checkpoints junction', () => {
  for (const operation of ['save', 'load', 'clear'] as const) {
    const root = tempRoot();
    const outside = tempRoot('kcw-checkpoint-outside-');
    const runId = `run_${operation}_junction`;
    fs.writeFileSync(path.join(outside, `${runId}.json`), `${JSON.stringify(runCheckpoint(runId))}\n`, 'utf8');
    linkDirectory(outside, path.join(root, 'checkpoints'));
    const checkpointer = new RunCheckpointer({ root });

    assert.throws(
      () => operation === 'save'
        ? checkpointer.save({ runId, step: 2 })
        : checkpointer[operation](runId),
      /symbolic link|junction|reparse|managed|path boundary/i,
    );
    assert.equal(fs.existsSync(path.join(outside, '.owners')), false);
    assert.equal(fs.readFileSync(path.join(outside, `${runId}.json`), 'utf8').includes(`"runId":"${runId}"`), true);
  }
});

test('RunCheckpointer rejects a regular checkpoints directory replaced during save', () => {
  const root = tempRoot();
  const checkpoints = path.join(root, 'checkpoints');
  const displaced = path.join(root, 'checkpoints-original');
  fs.mkdirSync(checkpoints);
  const checkpointer = new RunCheckpointer({ root });
  const originalMkdirSync = fs.mkdirSync;
  let swapped = false;
  fs.mkdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalMkdirSync, fs, args);
    if (!swapped && samePathReal(String(args[0]), path.join(checkpoints, '.owners'))) {
      fs.renameSync(checkpoints, displaced);
      originalMkdirSync(checkpoints);
      swapped = true;
    }
    return result;
  }) as typeof fs.mkdirSync;
  try {
    assert.throws(
      () => checkpointer.save({ runId: 'run_checkpoint_dir_swap', step: 1 }),
      /changed during operation|path boundary|managed/i,
    );
  } finally {
    fs.mkdirSync = originalMkdirSync;
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(checkpoints), []);
});

test('RunCheckpointer load revalidates file identity after reading', () => {
  const root = tempRoot();
  const checkpointer = new RunCheckpointer({ root });
  const runId = 'run_checkpoint_read_swap';
  const file = checkpointer.save({ runId, step: 1 });
  const displaced = `${file}.original`;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReadFileSync, fs, args);
    const target = args[0];
    if (!swapped && (typeof target === 'number' || path.resolve(String(target)) === path.resolve(file))) {
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, `${JSON.stringify(runCheckpoint(runId))}\n`, 'utf8');
      swapped = true;
    }
    return result;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => checkpointer.load(runId), /changed during operation|path boundary|managed file/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(swapped, true);
});

test('RunCheckpointer clear refuses a checkpoint replaced after it was pinned', () => {
  const root = tempRoot();
  const checkpointer = new RunCheckpointer({ root });
  const runId = 'run_checkpoint_delete_swap';
  const file = checkpointer.save({ runId, step: 1 });
  const displaced = `${file}.original`;
  fs.renameSync(file, displaced);
  fs.writeFileSync(file, `${JSON.stringify(runCheckpoint(runId))}\n`, 'utf8');

  assert.throws(() => checkpointer.clear(runId), /changed during operation|path boundary|managed/i);
  assert.equal(fs.existsSync(file), true, 'replacement must not be deleted');
});

test('orchestrator checkpoint save and load reject the orchestrator directory junction', () => {
  for (const operation of ['save', 'load'] as const) {
    const root = tempRoot();
    const outside = tempRoot('kcw-orchestrator-outside-');
    const runId = `run_orchestrator_${operation}_junction`;
    const input = orchestrationCheckpoint(runId, root);
    const file = path.join(outside, `${runId}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ ...input, checkpointPath: path.join(root, 'orchestrator-checkpoints', `${runId}.json`) })}\n`, 'utf8');
    linkDirectory(outside, path.join(root, 'orchestrator-checkpoints'));
    const store = createOrchestrationCheckpointStore({ root });

    assert.throws(
      () => operation === 'save' ? store.save(input) : store.load(runId),
      /symbolic link|junction|reparse|managed|path boundary/i,
    );
    assert.equal(fs.existsSync(file), true);
  }
});

test('orchestrator checkpoint load revalidates file identity after reading', () => {
  const root = tempRoot();
  const store = createOrchestrationCheckpointStore({ root });
  const runId = 'run_orchestrator_read_swap';
  const file = store.save(orchestrationCheckpoint(runId, root));
  const displaced = `${file}.original`;
  const originalReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReadFileSync, fs, args);
    const target = args[0];
    if (!swapped && (typeof target === 'number' || path.resolve(String(target)) === path.resolve(file))) {
      fs.renameSync(file, displaced);
      fs.writeFileSync(file, String(result), 'utf8');
      swapped = true;
    }
    return result;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => store.load(runId), /changed during operation|path boundary|managed file/i);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(swapped, true);
});
