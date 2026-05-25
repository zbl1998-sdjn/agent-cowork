import assert from 'node:assert/strict';
import test from 'node:test';
import { createOAuthPermissionApprovalStore } from '../src/runtime/oauth-permission-approvals.js';

function createStore() {
  let current = 1000;
  let next = 1;
  const store = createOAuthPermissionApprovalStore({
    ttlMs: 100,
    now: () => current,
    generateId: () => `approval-${next++}`,
  });
  return {
    store,
    advance(ms) {
      current += ms;
    },
  };
}

function approvalRequest(overrides = {}) {
  return {
    connectorId: 'github',
    provider: 'github',
    scopes: ['read:user', 'repo'],
    context: { tenantId: 'tenant-a', userId: 'user-a' },
    ...overrides,
  };
}

test('OAuth permission approvals are one-time receipts scoped to the request hash', () => {
  const { store } = createStore();
  const issued = store.issue(approvalRequest());
  assert.equal(issued.id, 'approval-1');
  assert.equal(store.pendingCount(), 1);

  const consumed = store.consume(issued.id, approvalRequest());
  assert.equal(consumed.id, issued.id);
  assert.equal(consumed.connectorId, 'github');
  assert.equal(store.pendingCount(), 0);

  assert.throws(() => store.consume(issued.id, approvalRequest()), {
    statusCode: 403,
    message: /invalid or expired/i,
  });
});

test('OAuth permission approvals reject tenant and user mismatches', () => {
  const { store } = createStore();
  const issued = store.issue(approvalRequest());

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ context: { tenantId: 'tenant-b', userId: 'user-a' } })),
    { statusCode: 403, message: /does not match/i },
  );
  assert.equal(store.pendingCount(), 1);

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ context: { tenantId: 'tenant-a', userId: 'user-b' } })),
    { statusCode: 403, message: /does not match/i },
  );
  assert.equal(store.pendingCount(), 1);

  assert.equal(store.consume(issued.id, approvalRequest()).id, issued.id);
});

test('OAuth permission approvals reject connector provider and scope mismatches', () => {
  const { store } = createStore();
  const issued = store.issue(approvalRequest());

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ connectorId: 'filesystem' })),
    { statusCode: 403, message: /does not match/i },
  );
  assert.throws(
    () => store.consume(issued.id, approvalRequest({ provider: 'gitlab' })),
    { statusCode: 403, message: /does not match/i },
  );
  assert.throws(
    () => store.consume(issued.id, approvalRequest({ scopes: ['read:user'] })),
    { statusCode: 403, message: /does not match/i },
  );

  assert.equal(store.consume(issued.id, approvalRequest()).id, issued.id);
});

test('OAuth permission approvals expire and reject missing receipt ids', () => {
  const { store, advance } = createStore();
  const issued = store.issue(approvalRequest());
  advance(101);

  assert.equal(store.pendingCount(), 0);
  assert.throws(() => store.consume(issued.id, approvalRequest()), {
    statusCode: 403,
    message: /invalid or expired/i,
  });
  assert.throws(() => store.consume('', approvalRequest()), {
    statusCode: 428,
    message: /required/i,
  });
});
