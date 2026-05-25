import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopGuard, createLoopGuard } from '../src/kimi/agent/loop-guard.js';

test('loop guard breaks when the same tool and args repeat at the threshold', () => {
  const guard = createLoopGuard({ maxRepeats: 3 });
  const call = { name: 'Read', args: { path: 'a.txt', options: { encoding: 'utf8', trim: true } } };

  assert.equal(guard.observe(call, true).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Read', args: { options: { trim: true, encoding: 'utf8' }, path: 'a.txt' } }, true).shouldBreak, false);
  const decision = guard.observe(call, true);

  assert.equal(decision.shouldBreak, true);
  assert.match(decision.reason, /repeated/i);
  assert.match(decision.reason, /Read/);
  assert.equal(guard.shouldBreak().shouldBreak, true);
});

test('loop guard tracks consecutive failures and resets after success', () => {
  const guard = new LoopGuard({ maxConsecutiveFailures: 2 });

  assert.equal(guard.observe({ name: 'Shell', args: { command: 'npm test' } }, false).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Shell', args: { command: 'npm test' } }, true).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Shell', args: { command: 'npm test' } }, false).shouldBreak, false);
  const decision = guard.observe({ name: 'Shell', args: { command: 'npm test' } }, false);

  assert.equal(decision.shouldBreak, true);
  assert.match(decision.reason, /failed/i);
  assert.match(decision.reason, /Shell/);
});

test('loop guard does not mix different tools or materially different args', () => {
  const guard = createLoopGuard({ maxRepeats: 2, maxConsecutiveFailures: 3 });

  assert.equal(guard.observe({ name: 'Read', args: { path: 'a.txt' } }, true).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Read', args: { path: 'b.txt' } }, true).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Glob', args: { pattern: '*.txt' } }, true).shouldBreak, false);
  assert.equal(guard.observe({ name: 'Read', args: { path: 'a.txt' } }, true).shouldBreak, true);
});
