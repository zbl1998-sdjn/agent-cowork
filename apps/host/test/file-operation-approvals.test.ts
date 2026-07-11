import test from 'node:test';
import assert from 'node:assert/strict';
import type { FileOperationApprovalContext } from '../src/runtime/file-operation-approvals.js';
import { createFileOperationApprovalStore } from '../src/runtime/file-operation-approvals.js';

test('file operation approvals are scoped and single-use', () => {
  const store = createFileOperationApprovalStore({ generateId: () => 'fop_test' });
  const operations = [{ type: 'write', path: 'out.txt', beforeHash: null, afterHash: 'abc' }];
  const context: FileOperationApprovalContext = { tenantId: 'tenant_a', userId: 'user_a' };
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
  const context: FileOperationApprovalContext = { tenantId: 'tenant_a', userId: 'user_a' };
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

test('file operation approval scope defaults only when context is omitted', () => {
  let next = 0;
  const store = createFileOperationApprovalStore({ generateId: () => `fop_${++next}` });
  const base = { kind: 'file-ops:apply', trustedRoot: '/tmp/root', operations: [] };
  const legacyId = store.issue(base);
  assert.doesNotThrow(() => store.consume(legacyId, base));

  const invalidContexts = [
    {},
    { tenantId: 'tenant_a' },
    { userId: 'user_a' },
    { tenantId: ' tenant_a', userId: 'user_a' },
  ];
  for (const context of invalidContexts) {
    assert.throws(() => store.issue({ ...base, context }), /canonical tenantId and userId are required/i);
  }
  const explicitUndefined = Object.defineProperty({ ...base }, 'context', {
    enumerable: true,
    value: undefined,
  });
  assert.throws(() => store.issue(explicitUndefined), /canonical tenantId and userId are required/i);
});
