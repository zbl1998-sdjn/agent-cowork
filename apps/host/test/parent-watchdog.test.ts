import assert from 'node:assert/strict';
import test from 'node:test';
import { startParentWatchdog } from '../src/util/parent-watchdog.js';

test('watchdog fires onParentGone once when the parent disappears', async () => {
  let alive = true;
  let fired = 0;
  const stop = startParentWatchdog({
    parentPid: 4242,
    intervalMs: 10,
    isAlive: () => alive,
    onParentGone: () => { fired += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fired, 0, 'must not fire while the parent is alive');
  alive = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fired, 1, 'fires exactly once after the parent is gone');
  stop();
});

test('watchdog is a no-op for invalid parent pids', async () => {
  let fired = 0;
  const stop = startParentWatchdog({
    parentPid: 0,
    intervalMs: 5,
    isAlive: () => false,
    onParentGone: () => { fired += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, 0);
  stop();
});

test('stop() prevents any further checks', async () => {
  let fired = 0;
  const stop = startParentWatchdog({
    parentPid: 4242,
    intervalMs: 5,
    isAlive: () => false,
    onParentGone: () => { fired += 1; },
  });
  stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fired, 0, 'stopped watchdog must not fire');
});
