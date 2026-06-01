import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

test('TTL prune resolves abandoned pending requests with reject (no leak / no hang)', async () => {
  const reg = createApprovalRegistry({ ttlMs: 20 });
  const { id, promise } = reg.request({ kind: 'question' });
  assert.equal(reg.pendingCount(), 1);
  await new Promise((r) => setTimeout(r, 35));
  const pruned = reg.prune();
  assert.equal(pruned, 1, 'one entry pruned past TTL');
  assert.equal(reg.pendingCount(), 0);
  assert.equal(await promise, 'reject', 'awaiter unblocked with reject');
  assert.equal(reg.resolve(id, 'once'), false, 'already gone');
});

test('capacity cap drops the oldest pending request when full', async () => {
  const reg = createApprovalRegistry({ maxPending: 2 });
  const a = reg.request({ n: 1 });
  reg.request({ n: 2 });
  assert.equal(reg.pendingCount(), 2);
  reg.request({ n: 3 }); // over cap -> oldest (a) is dropped
  assert.equal(reg.pendingCount(), 2);
  assert.equal(await a.promise, 'reject', 'oldest evicted with reject');
});

test('cancelByRun unblocks only the matching run\'s pending requests', async () => {
  const reg = createApprovalRegistry();
  const r1a = reg.request({ runId: 'run-1', kind: 'question' });
  const r1b = reg.request({ runId: 'run-1', name: 'Shell' });
  const r2 = reg.request({ runId: 'run-2', name: 'Write' });
  const n = reg.cancelByRun('run-1');
  assert.equal(n, 2, 'both run-1 entries cancelled');
  assert.equal(await r1a.promise, 'reject');
  assert.equal(await r1b.promise, 'reject');
  assert.equal(reg.pendingCount(), 1, 'run-2 entry still pending');
  assert.equal(reg.resolve(r2.id, 'once'), true);
});
