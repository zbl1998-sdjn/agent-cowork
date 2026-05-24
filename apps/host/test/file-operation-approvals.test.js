import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileOperationApprovalStore } from '../src/runtime/file-operation-approvals.js';

test('file operation approvals are scoped and single-use', () => {
  const store = createFileOperationApprovalStore({ generateId: () => 'fop_test' });
  const operations = [{ type: 'write', path: 'out.txt', beforeHash: null, afterHash: 'abc' }];
  const context = { tenantId: 'tenant_a', userId: 'user_a' };
  const id = store.issue({ kind: 'file-ops:apply', trustedRoot: '/tmp/root', operations, context });

  assert.equal(id, 'fop_test');
  assert.equal(store.pendingCount(), 1);
  assert.doesNotThrow(() => store.consume(id, { kind: 'file-ops:apply', trustedRoot: '/tmp/root', operations, context }));
  assert.equal(store.pendingCount(), 0);

  assert.throws(
    () => store.consume(id, { kind: 'file-ops:apply', trustedRoot: '/tmp/root', operations, context }),
    /invalid or expired/,
  );
});

test('file operation approvals reject mismatched operation scope', () => {
  const store = createFileOperationApprovalStore({ generateId: () => 'fop_test' });
  const context = { tenantId: 'tenant_a', userId: 'user_a' };
  const operations = [{ type: 'write', path: 'out.txt', beforeHash: null, afterHash: 'abc' }];
  const id = store.issue({ kind: 'file-ops:apply', trustedRoot: '/tmp/root', operations, context });

  assert.throws(
    () => store.consume(id, {
      kind: 'file-ops:apply',
      trustedRoot: '/tmp/root',
      operations: [{ type: 'write', path: 'out.txt', beforeHash: null, afterHash: 'def' }],
      context,
    }),
    /does not match/,
  );
  assert.equal(store.pendingCount(), 1);

  assert.throws(
    () => store.consume(id, {
      kind: 'file-ops:apply',
      trustedRoot: '/tmp/root',
      operations,
      context: { tenantId: 'tenant_b', userId: 'user_a' },
    }),
    /does not match/,
  );
  assert.equal(store.pendingCount(), 1);
});
