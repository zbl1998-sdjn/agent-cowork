import assert from 'node:assert/strict';
import test from 'node:test';
import { RunEventBus } from '../src/runtime/run-events.js';

const alice = { tenantId: 'tenant_shared', userId: 'user_alice' };
const bob = { tenantId: 'tenant_shared', userId: 'user_bob' };

test('run event buffers and subscribers are isolated by exact tenant and user', () => {
  const bus = new RunEventBus();
  const aliceEvents: string[] = [];
  const bobEvents: string[] = [];
  const unsubscribeAlice = bus.subscribe('run_shared', (event) => aliceEvents.push(event.type), alice);
  const unsubscribeBob = bus.subscribe('run_shared', (event) => bobEvents.push(event.type), bob);

  bus.publish('run_shared', { type: 'alice_private' }, alice);
  bus.publish('run_shared', { type: 'bob_private' }, bob);

  assert.deepEqual(aliceEvents, ['alice_private']);
  assert.deepEqual(bobEvents, ['bob_private']);
  assert.deepEqual(bus.replay('run_shared', 0, alice).map((event) => event.type), ['alice_private']);
  assert.deepEqual(bus.replay('run_shared', 0, bob).map((event) => event.type), ['bob_private']);
  assert.equal(bus.subscriberCount('run_shared', alice), 1);
  assert.equal(bus.subscriberCount('run_shared', bob), 1);

  unsubscribeAlice();
  unsubscribeBob();
});

test('run event sequence and seed state are independent across users sharing a run id', () => {
  const bus = new RunEventBus();
  bus.seed('run_shared', [{ seq: 9, type: 'persisted' }], alice);

  assert.equal(bus.publish('run_shared', { type: 'alice_live' }, alice).seq, 10);
  assert.equal(bus.publish('run_shared', { type: 'bob_live' }, bob).seq, 1);
});

test('run event scopes allow omitted legacy-local scope but reject provided invalid identities', () => {
  const bus = new RunEventBus();
  assert.equal(bus.publish('run_legacy', { type: 'local' }).seq, 1);

  for (const scope of [
    {},
    { tenantId: 'tenant_shared' },
    { userId: 'user_alice' },
    { tenantId: ' tenant_shared', userId: 'user_alice' },
    { tenantId: 'tenant_shared', userId: undefined },
  ]) {
    assert.throws(
      () => bus.publish('run_shared', { type: 'invalid' }, scope),
      /canonical tenantId and userId/i,
    );
    assert.throws(
      () => bus.replay('run_shared', 0, scope),
      /canonical tenantId and userId/i,
    );
  }
});
