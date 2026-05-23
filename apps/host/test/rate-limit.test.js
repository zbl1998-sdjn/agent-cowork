import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/runtime/rate-limit.js';

test('token bucket allows a burst then rejects with Retry-After', () => {
  let clock = 0;
  const rl = createRateLimiter({ ratePerSec: 2, burst: 3, now: () => clock });
  assert.equal(rl.take('t1').allowed, true);
  assert.equal(rl.take('t1').allowed, true);
  assert.equal(rl.take('t1').allowed, true);
  const denied = rl.take('t1');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1);
  assert.equal(denied.remaining, 0);
});

test('bucket refills over time', () => {
  let clock = 0;
  const rl = createRateLimiter({ ratePerSec: 2, burst: 2, now: () => clock });
  rl.take('t1'); rl.take('t1');
  assert.equal(rl.take('t1').allowed, false);
  clock += 1000; // +1s -> +2 tokens
  assert.equal(rl.take('t1').allowed, true);
});

test('limits are isolated per tenant', () => {
  let clock = 0;
  const rl = createRateLimiter({ ratePerSec: 1, burst: 1, now: () => clock });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, false);
  assert.equal(rl.take('b').allowed, true, 'tenant b has its own bucket');
});
