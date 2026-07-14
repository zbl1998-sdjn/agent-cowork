import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveAgentRunStart } from '../src/routes/agent-resume.js';
import { streamAgentChat } from '../src/routes/agent-stream.js';
import { getCheckpointPath, RunCheckpointer } from '../src/runtime/run-checkpoint.js';
import { createRunId, getRunPath, readRunRecord, writeRunRecord } from '../src/runtime/run-store.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import { samePathReal } from './helpers/path-swap.js';

type Owner = { tenantId: string; userId: string };

const OWNER_A: Owner = { tenantId: 'tenant_a', userId: 'user_a' };
const OWNER_B: Owner = { tenantId: 'tenant_a', userId: 'user_b' };
const OWNER_C: Owner = { tenantId: 'tenant_c', userId: 'user_a' };
const LOCAL_OWNER: Owner = { tenantId: 'tenant_local', userId: 'user_local' };

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-run-owner-'));
}

function staleMissingPathError(candidate: unknown): Error & { code: string } {
  const error = new Error(
    `ENOENT: no such file or directory, lstat '${String(candidate)}'`,
  ) as Error & { code: string };
  error.code = 'ENOENT';
  return error;
}

class CapturingResponse {
  statusCode = 0;
  chunks: string[] = [];
  ended = false;

  writeHead(statusCode: number): void {
    this.statusCode = statusCode;
  }

  write(chunk: string | Buffer = ''): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  end(chunk: string | Buffer = ''): void {
    if (chunk) this.write(chunk);
    this.ended = true;
  }

  on(): this {
    return this;
  }

  text(): string {
    return this.chunks.join('');
  }
}

test('agent run identity namespaces public seeds by tenant and user and uses 128-bit random ids', () => {
  const left = resolveAgentRunStart({ body: { runSeed: 'shared-seed' }, runStoreRoot: null, requestContext: OWNER_A });
  const repeated = resolveAgentRunStart({ body: { runSeed: 'shared-seed' }, runStoreRoot: null, requestContext: OWNER_A });
  const otherUser = resolveAgentRunStart({ body: { runSeed: 'shared-seed' }, runStoreRoot: null, requestContext: OWNER_B });
  const otherTenant = resolveAgentRunStart({ body: { runSeed: 'shared-seed' }, runStoreRoot: null, requestContext: OWNER_C });

  assert.equal(left.runId, repeated.runId);
  assert.equal(left.startedAt.toISOString(), repeated.startedAt.toISOString());
  assert.equal(left.runId === otherUser.runId, false);
  assert.equal(left.runId === otherTenant.runId, false);
  assert.match(createRunId(new Date('2026-07-11T00:00:00.000Z')), /^run_20260711000000_[a-f0-9]{32}$/);
  assert.throws(
    () => resolveAgentRunStart({ body: {}, runStoreRoot: null } as never),
    /tenantId.*userId|run owner/i,
  );
});

test('checkpoint owner is immutable and ownerless legacy data is local-only', () => {
  const root = tempRoot();
  const checkpointer = new RunCheckpointer({ root });
  checkpointer.save({
    runId: 'run_owned_checkpoint',
    owner: OWNER_A,
    messages: [{ role: 'user', content: 'tenant A secret' }],
  });

  assert.throws(
    () => checkpointer.save({
      runId: 'run_owned_checkpoint',
      owner: OWNER_B,
      messages: [{ role: 'user', content: 'tenant B overwrite' }],
    }),
    /owner/i,
  );
  const owned = checkpointer.load('run_owned_checkpoint');
  assert.deepEqual(owned?.owner, OWNER_A);
  assert.deepEqual(owned?.messages, [{ role: 'user', content: 'tenant A secret' }]);

  const legacyRunId = 'run_legacy_local_checkpoint';
  const legacyPath = getCheckpointPath(root, legacyRunId);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, `${JSON.stringify({
    version: 1,
    runId: legacyRunId,
    step: 1,
    phase: 'completed',
    updatedAt: '2026-07-11T00:00:00.000Z',
    messages: [{ role: 'user', content: 'legacy local' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    approvedTools: [],
    todos: [],
    metadata: {},
  }, null, 2)}\n`, 'utf8');

  const local = resolveAgentRunStart({
    body: { resumeRunId: legacyRunId },
    runStoreRoot: root,
    requestContext: LOCAL_OWNER,
  });
  const nonLocal = resolveAgentRunStart({
    body: { resumeRunId: legacyRunId },
    runStoreRoot: root,
    requestContext: OWNER_A,
  });
  assert.ok(local.resumeState);
  assert.equal(nonLocal.resumeState, null);
});

test('cross-owner resume fails before model, approval, or inherited tool execution', async () => {
  const root = tempRoot();
  const runId = 'run_owner_a_resume';
  new RunCheckpointer({ root }).save({
    runId,
    owner: OWNER_A,
    messages: [
      { role: 'system', content: 'test' },
      { role: 'user', content: 'tenant A secret' },
    ],
    approvedTools: ['Write'],
  });
  const response = new CapturingResponse();
  let modelCalls = 0;
  let approvalRequests = 0;

  await streamAgentChat({
    response,
    requestContext: { ...OWNER_B, traceId: 'trace_owner_b' },
    body: { resumeRunId: runId },
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    runStoreRoot: root,
    runsIndex: { upsert: () => undefined },
    approvals: {
      request: () => {
        approvalRequests += 1;
        return { id: 'approval_owner_b', promise: Promise.resolve('once') };
      },
    },
    modelCall: async () => {
      modelCalls += 1;
      return {
        content: '',
        tool_calls: [{
          id: 'write_cross_owner',
          function: { name: 'Write', arguments: JSON.stringify({ path: 'cross-owner.txt', content: 'should not run' }) },
        }],
      };
    },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.ended, true);
  assert.match(response.text(), /检查点/);
  assert.equal(modelCalls, 0);
  assert.equal(approvalRequests, 0);
  assert.equal(fs.existsSync(path.join(root, 'cross-owner.txt')), false);
});

test('run records reject cross-owner overwrite and preserve the original record', () => {
  const root = tempRoot();
  const runId = 'run_owned_record';
  writeRunRecord(root, {
    id: runId,
    context: OWNER_A,
    status: 'running',
    input: { prompt: 'tenant A secret' },
  });

  assert.throws(
    () => writeRunRecord(root, {
      id: runId,
      context: OWNER_B,
      status: 'succeeded',
      input: { prompt: 'tenant B overwrite' },
    }),
    /owner/i,
  );
  assert.equal(readRunRecord(root, runId)?.input?.prompt, 'tenant A secret');

  assert.doesNotThrow(() => writeRunRecord(root, {
    id: runId,
    context: OWNER_A,
    status: 'succeeded',
    input: { prompt: 'tenant A final' },
  }));
  assert.equal(readRunRecord(root, runId)?.input?.prompt, 'tenant A final');
});

test('run records reject partial, mixed-source, and non-canonical owners', () => {
  const root = tempRoot();
  for (const record of [
    { id: 'run_partial_context', context: { tenantId: 'tenant_a' } },
    { id: 'run_mixed_owner', tenantId: 'tenant_a', context: { userId: 'user_a' } },
    { id: 'run_trimmed_owner', context: { tenantId: ' tenant_a', userId: 'user_a' } },
  ]) {
    assert.throws(
      () => writeRunRecord(root, record),
      /canonical tenantId and userId/i,
    );
  }

  assert.doesNotThrow(() => writeRunRecord(root, {
    id: 'run_ownerless_legacy',
    status: 'succeeded',
  }));
});

test('atomic owner claims reject interleaved first writes for run records and checkpoints', () => {
  const runRoot = tempRoot();
  const runId = 'run_interleaved_record';
  const runPath = getRunPath(runRoot, runId);
  const originalRunLstatSync = fs.lstatSync;
  let insertedRunWrite = false;

  fs.lstatSync = ((candidate: unknown, ...args: unknown[]) => {
    if (!insertedRunWrite && samePathReal(String(candidate), runPath)) {
      insertedRunWrite = true;
      writeRunRecord(runRoot, {
        id: runId,
        context: OWNER_B,
        status: 'running',
        input: { prompt: 'owner B claimed first' },
      });
      throw staleMissingPathError(candidate);
    }
    return Reflect.apply(originalRunLstatSync, fs, [candidate, ...args]);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => writeRunRecord(runRoot, {
        id: runId,
        context: OWNER_A,
        status: 'succeeded',
        input: { prompt: 'owner A raced second' },
      }),
      /owner|claim/i,
    );
  } finally {
    fs.lstatSync = originalRunLstatSync;
  }
  assert.equal(insertedRunWrite, true);
  assert.equal(readRunRecord(runRoot, runId)?.input?.prompt, 'owner B claimed first');

  const checkpointRoot = tempRoot();
  const checkpointId = 'run_interleaved_checkpoint';
  const checkpointPath = getCheckpointPath(checkpointRoot, checkpointId);
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const checkpointer = new RunCheckpointer({ root: checkpointRoot });
  const originalCheckpointLstatSync = fs.lstatSync;
  let insertedCheckpointWrite = false;

  fs.lstatSync = ((candidate: unknown, ...args: unknown[]) => {
    if (!insertedCheckpointWrite && samePathReal(String(candidate), checkpointPath)) {
      insertedCheckpointWrite = true;
      checkpointer.save({ runId: checkpointId, owner: OWNER_B, phase: 'owner_b_claimed_first' });
      throw staleMissingPathError(candidate);
    }
    return Reflect.apply(originalCheckpointLstatSync, fs, [candidate, ...args]);
  }) as typeof fs.lstatSync;
  try {
    assert.throws(
      () => checkpointer.save({ runId: checkpointId, owner: OWNER_A, phase: 'owner_a_raced_second' }),
      /owner|claim/i,
    );
  } finally {
    fs.lstatSync = originalCheckpointLstatSync;
  }
  assert.equal(insertedCheckpointWrite, true);
  assert.equal(checkpointer.load(checkpointId)?.phase, 'owner_b_claimed_first');
});

test('a partial first run-owner claim write leaves no final claim and can be retried', () => {
  const root = tempRoot();
  const runId = 'run_partial_owner_claim';
  const claimPath = path.join(root, '.owners', `${runId}.json`);
  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;

  fs.writeFileSync = ((...args: unknown[]) => {
    const [destination] = args;
    if (!injected && (typeof destination === 'number'
      || samePathReal(String(destination), claimPath))) {
      injected = true;
      if (typeof destination === 'number') {
        const writeDescriptor = originalWriteFileSync as unknown as (
          descriptor: number,
          data: string,
          encoding: string,
        ) => void;
        writeDescriptor(destination, '{"version":1', 'utf8');
      } else {
        originalWriteFileSync(String(destination), '{"version":1', 'utf8');
      }
      throw new Error('injected partial owner claim write');
    }
    return Reflect.apply(originalWriteFileSync, fs, args);
  }) as typeof fs.writeFileSync;

  try {
    assert.throws(
      () => writeRunRecord(root, {
        id: runId,
        context: OWNER_A,
        status: 'running',
      }),
      /injected partial owner claim write/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.existsSync(claimPath), false);
  assert.equal(fs.existsSync(getRunPath(root, runId)), false);
  assert.doesNotThrow(() => writeRunRecord(root, {
    id: runId,
    context: OWNER_A,
    status: 'running',
  }));
  assert.equal(readRunRecord(root, runId)?.id, runId);
});
