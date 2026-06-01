import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

test('approval registry resolves a pending request with a decision', async () => {
  const registry = createApprovalRegistry();
  const { id, promise } = registry.request({ name: 'Shell' });
  assert.match(id, /^apr_/);
  assert.equal(registry.resolve(id, 'once'), true);
  assert.equal(await promise, 'once');
  assert.equal(registry.resolve('ghost', 'once'), false);
});

test('approval registry resolveMany resolves only exact IDs and preserves scope', async () => {
  const registry = createApprovalRegistry();
  const first = registry.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  const second = registry.request({ name: 'Write', tenantId: 'tenant_a', userId: 'user_a' });

  assert.deepEqual(registry.resolveMany([first.id, second.id], 'session', { tenantId: 'tenant_b', userId: 'user_a' }), [
    { id: first.id, ok: false },
    { id: second.id, ok: false },
  ]);
  assert.deepEqual(registry.resolveMany([first.id, 'ghost', second.id, first.id], 'session', { tenantId: 'tenant_a', userId: 'user_a' }), [
    { id: first.id, ok: true },
    { id: 'ghost', ok: false },
    { id: second.id, ok: true },
  ]);
  assert.equal(await first.promise, 'session');
  assert.equal(await second.promise, 'session');
});

test('approval registry rejects resolve attempts from the wrong tenant/user scope', async () => {
  const registry = createApprovalRegistry();
  const { id, promise } = registry.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  assert.equal(registry.resolve(id, 'once', { tenantId: 'tenant_b', userId: 'user_a' }), false);
  assert.equal(registry.respond(id, 'ok', { tenantId: 'tenant_a', userId: 'user_b' }), false);
  assert.equal(registry.resolve(id, 'once', { tenantId: 'tenant_a', userId: 'user_a' }), true);
  assert.equal(await promise, 'once');
});
