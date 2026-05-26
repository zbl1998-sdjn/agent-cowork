import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundTasks } from '../src/runtime/background-tasks.js';

test('register creates a running task at zero progress', () => {
  const bt = createBackgroundTasks();
  const t = bt.register({ id: 'a', title: '分析三个文件夹', kind: 'subagent' });
  assert.equal(t.status, 'running');
  assert.equal(t.progress, 0);
  assert.equal(t.title, '分析三个文件夹');
  assert.equal(bt.pendingCount(), 1);
});

test('register requires an id', () => {
  const bt = createBackgroundTasks();
  assert.throws(() => bt.register({}), /id is required/);
});

test('update clamps progress into 0..1 and patches fields', () => {
  const bt = createBackgroundTasks();
  bt.register({ id: 'a' });
  assert.equal(bt.update('a', { progress: 2 }).progress, 1);
  assert.equal(bt.update('a', { progress: -1 }).progress, 0);
  assert.equal(bt.update('a', { title: '改了' }).title, '改了');
  assert.equal(bt.update('missing', { progress: 0.5 }), null);
});

test('complete(ok) marks done, fills progress, and notifies subscribers', () => {
  const bt = createBackgroundTasks();
  const seen = [];
  bt.onComplete((task) => seen.push(task));
  bt.register({ id: 'a' });
  const done = bt.complete('a', { ok: true, result: { files: 3 } });
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 1);
  assert.deepEqual(done.result, { files: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'a');
  assert.equal(bt.pendingCount(), 0);
});

test('complete(fail) records the error and notifies', () => {
  const bt = createBackgroundTasks();
  const seen = [];
  bt.onComplete((task) => seen.push(task));
  bt.register({ id: 'a' });
  const failed = bt.complete('a', { ok: false, error: 'timeout' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'timeout');
  assert.equal(seen.length, 1);
});

test('cancel marks the task cancelled', () => {
  const bt = createBackgroundTasks();
  bt.register({ id: 'a' });
  assert.equal(bt.cancel('a').status, 'cancelled');
  assert.equal(bt.pendingCount(), 0);
});

test('list filters by status', () => {
  const bt = createBackgroundTasks();
  bt.register({ id: 'a' });
  bt.register({ id: 'b' });
  bt.complete('b', { ok: true });
  assert.equal(bt.list({ status: 'running' }).length, 1);
  assert.equal(bt.list({ status: 'done' }).length, 1);
  assert.equal(bt.list().length, 2);
});

test('onComplete returns an unsubscribe that stops further notifications', () => {
  const bt = createBackgroundTasks();
  let count = 0;
  const off = bt.onComplete(() => { count += 1; });
  bt.register({ id: 'a' });
  bt.complete('a', { ok: true });
  off();
  bt.register({ id: 'b' });
  bt.complete('b', { ok: true });
  assert.equal(count, 1);
});

test('a throwing subscriber does not break completion', () => {
  const bt = createBackgroundTasks();
  bt.onComplete(() => { throw new Error('boom'); });
  bt.register({ id: 'a' });
  assert.doesNotThrow(() => bt.complete('a', { ok: true }));
  assert.equal(bt.get('a').status, 'done');
});
