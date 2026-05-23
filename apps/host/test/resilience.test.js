import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, OpenCircuitError } from '../src/runtime/circuit-breaker.js';
import { withTimeout, withRetry, fallbackChain, TimeoutError } from '../src/runtime/resilience.js';

test('circuit breaker: opens after threshold, short-circuits, recovers via half-open', async () => {
  let clock = 0;
  const cb = new CircuitBreaker({ name: 'm', failureThreshold: 3, cooldownMs: 1000, now: () => clock });
  // 3 failures -> open
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => cb.run(async () => { throw new Error('boom'); }));
  }
  assert.equal(cb.state, 'open');
  // open: calls short-circuit immediately
  await assert.rejects(() => cb.run(async () => 'should not run'), (e) => e instanceof OpenCircuitError);

  // after cooldown -> half-open allows one trial; success closes it
  clock += 1000;
  assert.equal(cb.state, 'half-open');
  const r = await cb.run(async () => 'ok');
  assert.equal(r, 'ok');
  assert.equal(cb.state, 'closed');
});

test('circuit breaker: a failed half-open trial re-opens the circuit', async () => {
  let clock = 0;
  const cb = new CircuitBreaker({ name: 'm', failureThreshold: 1, cooldownMs: 500, now: () => clock });
  await assert.rejects(() => cb.run(async () => { throw new Error('x'); }));
  assert.equal(cb.state, 'open');
  clock += 500;
  assert.equal(cb.state, 'half-open');
  await assert.rejects(() => cb.run(async () => { throw new Error('still down'); }));
  assert.equal(cb.state, 'open');
});

test('withTimeout rejects slow work and resolves fast work', async () => {
  await assert.rejects(
    () => withTimeout(new Promise((r) => setTimeout(() => r('late'), 50)), 10, 'slow'),
    (e) => e instanceof TimeoutError,
  );
  assert.equal(await withTimeout(Promise.resolve('quick'), 50), 'quick');
});

test('withRetry retries transient failures then succeeds; respects shouldRetry', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls += 1; if (calls < 3) throw new Error('transient'); return 'done'; },
    { retries: 5, sleep: async () => {}, jitter: false });
  assert.equal(r, 'done');
  assert.equal(calls, 3);

  let calls2 = 0;
  await assert.rejects(
    () => withRetry(async () => { calls2 += 1; const e = new Error('fatal'); e.fatal = true; throw e; },
      { retries: 5, sleep: async () => {}, shouldRetry: (e) => !e.fatal }),
  );
  assert.equal(calls2, 1, 'must not retry when shouldRetry=false');
});

test('fallbackChain returns first success and aggregates on total failure', async () => {
  const order = [];
  const r = await fallbackChain([
    async () => { order.push('l1'); throw new Error('l1 down'); },
    async () => { order.push('l2'); return 'degraded'; },
    async () => { order.push('l3'); return 'fallback'; },
  ]);
  assert.equal(r, 'degraded');
  assert.deepEqual(order, ['l1', 'l2']);

  await assert.rejects(
    () => fallbackChain([async () => { throw new Error('a'); }, async () => { throw new Error('b'); }]),
    (e) => e.code === 'FALLBACK_EXHAUSTED' && e.errors.length === 2,
  );
});
