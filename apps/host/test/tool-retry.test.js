import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicy, createRetryPolicy, isRetryableToolError } from '../src/kimi/agent/tool-retry.js';

test('retry policy retries transient thrown errors with bounded exponential backoff', async () => {
  const delays = [];
  let attempts = 0;
  const policy = createRetryPolicy({
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 25,
    sleep: async (delay) => { delays.push(delay); },
  });

  const result = await policy.run(async () => {
    attempts += 1;
    if (attempts < 3) {
      const err = new Error('ETIMEDOUT: network timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    return { ok: true, attempts };
  });

  assert.deepEqual(result, { ok: true, attempts: 3 });
  assert.deepEqual(delays, [10, 20]);
});

test('retry policy does not retry permanent permission or validation failures', async () => {
  let attempts = 0;
  const policy = new RetryPolicy({
    maxAttempts: 5,
    sleep: async () => {
      throw new Error('sleep should not be called');
    },
  });

  await assert.rejects(
    () => policy.run(async () => {
      attempts += 1;
      const err = new Error('permission denied: path escaped trusted root');
      err.code = 'EACCES';
      throw err;
    }),
    /permission denied/i,
  );
  assert.equal(attempts, 1);
  assert.equal(isRetryableToolError(new Error('invalid args: missing path')), false);
});

test('retry policy can retry returned tool error objects and exposes attempt metadata', async () => {
  const delays = [];
  let attempts = 0;
  const policy = createRetryPolicy({
    maxAttempts: 3,
    baseDelayMs: 5,
    sleep: async (delay) => { delays.push(delay); },
  });

  const result = await policy.run(async () => {
    attempts += 1;
    if (attempts === 1) return { error: 'EBUSY: file is locked' };
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(delays, [5]);
  assert.equal(policy.lastRun.attempts, 2);
  assert.equal(policy.lastRun.retried, true);
});
