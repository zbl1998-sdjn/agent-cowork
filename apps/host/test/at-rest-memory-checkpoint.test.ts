// 落盘加密接入(切片 2c)——记忆 + checkpoints 透明加密 + 遗留明文兼容
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendMemoryFact, readMainMemory, writeMemoryNote, readMemoryNote } from '../src/memory/file-memory-store.js';
import { RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { createOrchestrationCheckpointStore } from '../src/orchestrator/checkpoint-store.js';
import { clearAtRestProtectorCache } from '../src/security/at-rest.js';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-atrest-mc-'));
}
function withEncryption<T>(fn: () => T): T {
  const prev = process.env.KCW_ENCRYPT_AT_REST;
  process.env.KCW_ENCRYPT_AT_REST = '1';
  clearAtRestProtectorCache();
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KCW_ENCRYPT_AT_REST; else process.env.KCW_ENCRYPT_AT_REST = prev;
    clearAtRestProtectorCache();
  }
}

const SECRET = '机密事实:客户名单在 D 盘 clients.xlsx';
const owner = { tenantId: 'tenant_local', userId: 'user_local' };

test('memory main file + notes are sealed on disk but round-trip when encryption is on', () => {
  const root = tmp();
  withEncryption(() => {
    const { file: memFile } = appendMemoryFact(root, { key: 'clients', value: SECRET, scope: 'project' }, owner);
    assert.ok(!fs.readFileSync(memFile, 'utf8').includes(SECRET), 'MEMORY.md leaked plaintext');
    assert.match(fs.readFileSync(memFile, 'utf8'), /^aesgcm:v1:/);
    assert.ok(readMainMemory(root, owner).includes(SECRET), 'memory round-trips');

    const noteFile = writeMemoryNote(root, 'note-a.md', SECRET, owner);
    assert.ok(!fs.readFileSync(noteFile, 'utf8').includes(SECRET));
    assert.match(fs.readFileSync(noteFile, 'utf8'), /^aesgcm:v1:/);
    assert.equal(readMemoryNote(root, 'note-a.md', owner), SECRET);
  });
});

test('empty encrypted memory notes remain valid AES-GCM ciphertext and round-trip', () => {
  const root = tmp();
  withEncryption(() => {
    const noteFile = writeMemoryNote(root, 'empty.md', '', owner);
    assert.match(fs.readFileSync(noteFile, 'utf8'), /^aesgcm:v1:[^:]+:[^:]+:$/);
    assert.equal(readMemoryNote(root, 'empty.md', owner), '');
  });
});

test('memory append composes correctly on top of a sealed existing file', () => {
  const root = tmp();
  withEncryption(() => {
    appendMemoryFact(root, { key: 'a', value: 'first', scope: 'project' }, owner);
    appendMemoryFact(root, { key: 'b', value: 'second', scope: 'user' }, owner);
    const mem = readMainMemory(root, owner);
    assert.ok(mem.includes('first') && mem.includes('second'), 'both facts survive sealed append');
  });
});

test('legacy plaintext MEMORY.md still reads after encryption is enabled', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.AgentCowork'), { recursive: true });
  fs.writeFileSync(path.join(root, '.AgentCowork', 'MEMORY.md'), '# memory\n- **x** (user): legacy fact\n', 'utf8');
  withEncryption(() => {
    assert.ok(readMainMemory(root, owner).includes('legacy fact'));
  });
});

test('run + orchestrator checkpoints are sealed on disk but round-trip', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  withEncryption(() => {
    const rc = new RunCheckpointer({ root: runStoreRoot });
    rc.save({ runId: 'run_ckpt_0001', step: 3, phase: 'assistant_tool_calls', messages: [{ role: 'user', content: SECRET }] });
    const ckptFile = path.join(runStoreRoot, 'checkpoints', 'run_ckpt_0001.json');
    assert.ok(!fs.readFileSync(ckptFile, 'utf8').includes(SECRET), 'run checkpoint leaked plaintext');
    assert.match(fs.readFileSync(ckptFile, 'utf8'), /^aesgcm:v1:/);
    const back = rc.load('run_ckpt_0001');
    assert.equal((back?.messages?.[0] as { content?: string })?.content, SECRET);

    const oc = createOrchestrationCheckpointStore({ root: runStoreRoot });
    oc.save({
      version: 1, runId: 'run_orch_0001', userGoal: SECRET, recipeId: 'weekly-report', mode: 'workflow', status: 'running',
      workspaceRoot: root, securityMode: 'local_strict', agents: [], refs: [], tasks: [], results: [],
      completedStepIds: [], currentStepId: 'research', eventsPath: path.join(runStoreRoot, 'e.jsonl'), checkpointPath: '',
      artifacts: [], startedAt: '2026-07-07T00:00:00.000Z', updatedAt: '2026-07-07T00:00:00.000Z',
    });
    const ocFile = path.join(runStoreRoot, 'orchestrator-checkpoints', 'run_orch_0001.json');
    assert.ok(!fs.readFileSync(ocFile, 'utf8').includes(SECRET), 'orchestrator checkpoint leaked plaintext');
    assert.equal(oc.load('run_orch_0001')?.userGoal, SECRET);
  });
});

test('run checkpoint writes cannot be redirected through the former predictable temp path', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const runId = 'run_ckpt_temp_guard';
  const checkpointFile = path.join(runStoreRoot, 'checkpoints', `${runId}.json`);
  const sentinel = path.join(root, 'sentinel-run.txt');
  const fixedNow = 1_750_000_000_000;
  const predictableTemp = `${checkpointFile}.${process.pid}.${fixedNow}.tmp`;
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  fs.writeFileSync(sentinel, 'sentinel-run', 'utf8');
  (fs as unknown as { linkSync(source: string, destination: string): void }).linkSync(
    sentinel,
    predictableTemp,
  );
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    new RunCheckpointer({ root: runStoreRoot }).save({ runId, step: 1 });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel-run');
});

test('orchestrator checkpoint writes cannot be redirected through the former predictable temp path', () => {
  const root = tmp();
  const runStoreRoot = path.join(root, '.AgentCowork', 'runs');
  const runId = 'run_orch_temp_guard';
  const checkpointFile = path.join(runStoreRoot, 'orchestrator-checkpoints', `${runId}.json`);
  const sentinel = path.join(root, 'sentinel-orchestrator.txt');
  const fixedNow = 1_750_000_000_001;
  const predictableTemp = `${checkpointFile}.${process.pid}.${fixedNow}.tmp`;
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true });
  fs.writeFileSync(sentinel, 'sentinel-orchestrator', 'utf8');
  (fs as unknown as { linkSync(source: string, destination: string): void }).linkSync(
    sentinel,
    predictableTemp,
  );
  const originalNow = Date.now;
  Date.now = () => fixedNow;
  try {
    createOrchestrationCheckpointStore({ root: runStoreRoot }).save({
      version: 1,
      runId,
      userGoal: 'guard temporary writes',
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
      currentStepId: 'research',
      eventsPath: path.join(runStoreRoot, 'guard.events.jsonl'),
      checkpointPath: '',
      artifacts: [],
      startedAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    });
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel-orchestrator');
});
