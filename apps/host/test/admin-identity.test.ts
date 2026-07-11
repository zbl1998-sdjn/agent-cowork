import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultFileSummaryCacheFor } from '../src/routes/orchestrator-summary-cache.js';
import {
  orchestratorOwner,
  visibleOrchestratorRecord,
} from '../src/routes/orchestrator-owner-guard.js';
import { idempotencyCacheKey } from '../src/runtime/idempotency-key.js';

test('orchestrator owner requires a complete canonical request identity', () => {
  assert.deepEqual(orchestratorOwner({ tenantId: 'tenant_a', userId: 'user_a' }), {
    tenantId: 'tenant_a',
    userId: 'user_a',
  });
  for (const context of [
    {},
    { tenantId: 'tenant_a' },
    { userId: 'user_a' },
    { tenantId: ' tenant_a', userId: 'user_a' },
  ]) {
    assert.throws(() => orchestratorOwner(context), /canonical tenantId and userId are required/i);
  }
});

test('orchestrator records fail closed instead of mixing or inventing stored owners', () => {
  const request = { tenantId: 'tenant_a', userId: 'user_a' };
  assert.equal(visibleOrchestratorRecord({
    id: 'run_exact',
    type: 'orchestrator',
    context: request,
  }, request), true);
  assert.equal(visibleOrchestratorRecord({
    id: 'run_partial',
    type: 'orchestrator',
    tenantId: 'tenant_a',
    userId: 'user_a',
    context: { tenantId: 'tenant_a' },
  }, request), false);
  assert.equal(visibleOrchestratorRecord({ id: 'run_ownerless', type: 'orchestrator' }, request), false);
  assert.equal(visibleOrchestratorRecord({
    id: 'run_top_level',
    type: 'orchestrator',
    tenantId: 'tenant_a',
    userId: 'user_a',
  }, request), true);
});

test('orchestrator summary caches isolate sibling users', () => {
  const alice = defaultFileSummaryCacheFor({ tenantId: 'tenant_a', userId: 'alice' });
  const aliceAgain = defaultFileSummaryCacheFor({ tenantId: 'tenant_a', userId: 'alice' });
  const bob = defaultFileSummaryCacheFor({ tenantId: 'tenant_a', userId: 'bob' });
  assert.equal(aliceAgain, alice);
  assert.equal(alice === bob, false);
  assert.throws(
    () => defaultFileSummaryCacheFor({ tenantId: 'tenant_a' }),
    /canonical tenantId and userId are required/i,
  );
});

test('idempotency cache keys require full identity and use collision-safe tuples', () => {
  const first = idempotencyCacheKey(
    { tenantId: 'tenant:a', userId: 'user', idempotencyKey: 'same' },
    'POST',
    '/api/admin',
  );
  const second = idempotencyCacheKey(
    { tenantId: 'tenant', userId: 'a:user', idempotencyKey: 'same' },
    'POST',
    '/api/admin',
  );
  assert.equal(first === second, false);
  assert.equal(idempotencyCacheKey({ tenantId: 'tenant_a', userId: 'user_a' }, 'POST', '/api/admin'), '');
  assert.throws(
    () => idempotencyCacheKey({ tenantId: 'tenant_a', idempotencyKey: 'same' }, 'POST', '/api/admin'),
    /canonical tenantId and userId are required/i,
  );
});
