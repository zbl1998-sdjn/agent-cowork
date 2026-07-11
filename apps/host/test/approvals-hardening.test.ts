import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

test('TTL automatically resolves abandoned pending requests with reject (no leak / no hang)', async () => {
  const reg = createApprovalRegistry({ ttlMs: 20 });
  const { id, promise } = reg.request({ kind: 'question' });
  assert.equal(reg.pendingCount(), 1);
  const decision = await Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve('test-timeout'), 200)),
  ]);
  assert.equal(decision, 'reject', 'TTL must release the waiter without requiring another registry call');
  assert.equal(reg.pendingCount(), 0);
  assert.equal(reg.prune(), 0, 'the expiry timer already removed the pending entry');
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

test('cancelByRun cannot cancel a sibling user approval with the same run id', async () => {
  const reg = createApprovalRegistry();
  const userA = reg.request({ runId: 'shared-run', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  const userB = reg.request({ runId: 'shared-run', tenantId: 'tenant-a', userId: 'user-b', kind: 'tool' });

  assert.equal(reg.cancelByRun('shared-run', { tenantId: 'tenant-a', userId: 'user-b' }), 1);
  assert.equal(await userB.promise, 'reject');
  assert.equal(reg.pendingCount(), 1);
  assert.equal(reg.resolve(userA.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await userA.promise, 'once');
});
