import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalRegistry } from '../src/runtime/approvals.js';

test('approval registry resolves a pending request with a decision', async () => {
  const registry = createApprovalRegistry();
  const { id, promise } = registry.request({ name: 'Shell' });
  assert.match(id, /^apr_[0-9a-f]{32}$/);
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

test('approval registry keeps question answers separate from tool and plan decisions', async () => {
  const registry = createApprovalRegistry();

  const tool = registry.request({ kind: 'tool', name: 'Shell' });
  assert.equal(registry.respond(tool.id, 'arbitrary answer'), false, 'free-form answers cannot approve tools');
  assert.equal(registry.resolve(tool.id, 'approve'), false, 'unknown decisions must fail closed');
  assert.equal(registry.resolve(tool.id, 'once'), true);
  assert.equal(await tool.promise, 'once');

  const plan = registry.request({ kind: 'plan', plan: 'write files' });
  assert.equal(registry.respond(plan.id, 'yes'), false, 'free-form answers cannot approve plans');
  assert.equal(registry.resolve(plan.id, 'reject'), true);
  assert.equal(await plan.promise, 'reject');

  const question = registry.request({ kind: 'question', question: 'Which format?' });
  assert.equal(registry.resolve(question.id, 'once'), false, 'decision values cannot answer questions');
  assert.equal(registry.respond(question.id, 'Excel'), true);
  assert.equal(await question.promise, 'Excel');
});

test('approval registry keeps internal unscoped approvals separate from scoped callers', async () => {
  const registry = createApprovalRegistry();
  const internal = registry.request({ name: 'Shell' });
  assert.equal(
    registry.resolve(internal.id, 'once', { tenantId: 'tenant_a', userId: 'user_a' }),
    false,
  );
  assert.equal(registry.resolve(internal.id, 'once'), true);
  assert.equal(await internal.promise, 'once');

  for (const meta of [
    { name: 'Shell', tenantId: 'tenant_a' },
    { name: 'Shell', userId: 'user_a' },
    { name: 'Shell', tenantId: ' tenant_a', userId: 'user_a' },
  ]) {
    assert.throws(() => registry.request(meta), /canonical tenantId and userId are required/i);
  }

  const scoped = registry.request({ name: 'Shell', tenantId: 'tenant_a', userId: 'user_a' });
  assert.throws(
    () => registry.resolve(scoped.id, 'once', { tenantId: 'tenant_a' }),
    /canonical tenantId and userId are required/i,
  );
  assert.equal(registry.resolve(scoped.id, 'once', { tenantId: 'tenant_a', userId: 'user_a' }), true);
  assert.equal(await scoped.promise, 'once');
});
