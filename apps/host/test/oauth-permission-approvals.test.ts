import assert from 'node:assert/strict';
import test from 'node:test';
import { createOAuthPermissionApprovalStore } from '../src/runtime/oauth-permission-approvals.js';
import type {
  OAuthPermissionApprovalStore,
  OAuthPermissionRequest,
} from '../src/runtime/oauth-permission-approvals.js';

type StoreFixture = {
  store: OAuthPermissionApprovalStore;
  advance(ms: number): void;
};

function expectedHttpError(statusCode: number, message: RegExp): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    const err = error as Error & { statusCode?: unknown };
    return err.statusCode === statusCode && message.test(err.message);
  };
}

function createStore(): StoreFixture {
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

function approvalRequest(overrides: Partial<OAuthPermissionRequest> = {}): OAuthPermissionRequest {
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

  assert.throws(
    () => store.consume(issued.id, approvalRequest()),
    expectedHttpError(403, /invalid or expired/i),
  );
});

test('OAuth permission approvals reject tenant and user mismatches', () => {
  const { store } = createStore();
  const issued = store.issue(approvalRequest());

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ context: { tenantId: 'tenant-b', userId: 'user-a' } })),
    expectedHttpError(403, /does not match/i),
  );
  assert.equal(store.pendingCount(), 1);

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ context: { tenantId: 'tenant-a', userId: 'user-b' } })),
    expectedHttpError(403, /does not match/i),
  );
  assert.equal(store.pendingCount(), 1);

  assert.equal(store.consume(issued.id, approvalRequest()).id, issued.id);
});

test('OAuth permission approvals reject connector provider and scope mismatches', () => {
  const { store } = createStore();
  const issued = store.issue(approvalRequest());

  assert.throws(
    () => store.consume(issued.id, approvalRequest({ connectorId: 'filesystem' })),
    expectedHttpError(403, /does not match/i),
  );
  assert.throws(
    () => store.consume(issued.id, approvalRequest({ provider: 'gitlab' })),
    expectedHttpError(403, /does not match/i),
  );
  assert.throws(
    () => store.consume(issued.id, approvalRequest({ scopes: ['read:user'] })),
    expectedHttpError(403, /does not match/i),
  );

  assert.equal(store.consume(issued.id, approvalRequest()).id, issued.id);
});

test('OAuth permission approvals expire and reject missing receipt ids', () => {
  const { store, advance } = createStore();
  const issued = store.issue(approvalRequest());
  advance(101);

  assert.equal(store.pendingCount(), 0);
  assert.throws(
    () => store.consume(issued.id, approvalRequest()),
    expectedHttpError(403, /invalid or expired/i),
  );
  assert.throws(
    () => store.consume('', approvalRequest()),
    expectedHttpError(428, /required/i),
  );
});

test('OAuth permission approval scope defaults only when context is omitted', () => {
  const { store } = createStore();
  const base = { connectorId: 'github', provider: 'github', scopes: ['read:user'] };
  const legacy = store.issue(base);
  assert.equal(store.consume(legacy.id, base).id, legacy.id);

  for (const context of [
    {},
    { tenantId: 'tenant-a' },
    { userId: 'user-a' },
    { tenantId: ' tenant-a', userId: 'user-a' },
  ]) {
    assert.throws(() => store.issue({ ...base, context }), /canonical tenantId and userId are required/i);
  }
  const explicitUndefined = Object.defineProperty({ ...base }, 'context', {
    enumerable: true,
    value: undefined,
  });
  assert.throws(() => store.issue(explicitUndefined), /canonical tenantId and userId are required/i);
});
