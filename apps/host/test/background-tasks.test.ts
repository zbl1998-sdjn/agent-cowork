import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackgroundTasks } from '../src/runtime/background-tasks.js';
import type { BackgroundTask } from '../src/runtime/background-tasks.js';

function mustTask(task: BackgroundTask | null): BackgroundTask {
  assert.ok(task);
  return task;
}

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
  assert.equal(mustTask(bt.update('a', { progress: 2 })).progress, 1);
  assert.equal(mustTask(bt.update('a', { progress: -1 })).progress, 0);
  assert.equal(mustTask(bt.update('a', { title: '改了' })).title, '改了');
  assert.equal(bt.update('missing', { progress: 0.5 }), null);
});

test('complete(ok) marks done, fills progress, and notifies subscribers', () => {
  const bt = createBackgroundTasks();
  const seen: BackgroundTask[] = [];
  bt.onComplete((task) => seen.push(task));
  bt.register({ id: 'a' });
  const done = mustTask(bt.complete('a', { ok: true, result: { files: 3 } }));
  assert.equal(done.status, 'done');
  assert.equal(done.progress, 1);
  assert.deepEqual(done.result, { files: 3 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.id, 'a');
  assert.equal(bt.pendingCount(), 0);
});

test('complete(fail) records the error and notifies', () => {
  const bt = createBackgroundTasks();
  const seen: BackgroundTask[] = [];
  bt.onComplete((task) => seen.push(task));
  bt.register({ id: 'a' });
  const failed = mustTask(bt.complete('a', { ok: false, error: 'timeout' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'timeout');
  assert.equal(seen.length, 1);
});

test('cancel marks the task cancelled', () => {
  const bt = createBackgroundTasks();
  bt.register({ id: 'a' });
  assert.equal(mustTask(bt.cancel('a')).status, 'cancelled');
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
  assert.equal(mustTask(bt.get('a')).status, 'done');
});

test('task snapshots, missing-task operations, and invalid subscribers are defensive', () => {
  let tick = 100;
  const bt = createBackgroundTasks({ now: () => {
    tick += 10;
    return tick;
  } });

  const registered = bt.register({ id: 'a', title: 'initial', kind: 'sync' });
  registered.title = 'mutated outside';
  registered.progress = 99;
  assert.equal(mustTask(bt.get('a')).title, 'initial');
  assert.equal(mustTask(bt.get('a')).progress, 0);
  assert.equal(registered.startedAt, 110);
  assert.equal(registered.updatedAt, 110);

  const ignored = mustTask(bt.update('a', { progress: '0.8', status: 'bogus' }));
  assert.equal(ignored.progress, 0);
  assert.equal(ignored.status, 'running');
  const patched = mustTask(bt.update('a', { progress: 0.4, status: 'done' }));
  assert.equal(patched.progress, 0.4);
  assert.equal(patched.status, 'done');
  assert.equal(patched.updatedAt, 130);

  assert.equal(bt.complete('missing'), null);
  assert.equal(bt.cancel('missing'), null);
  assert.equal(bt.remove('missing'), false);
  assert.equal(bt.remove('a'), true);
  assert.equal(bt.get('a'), null);

  const off = bt.onComplete(null as unknown as (task: BackgroundTask) => void);
  assert.equal(off(), undefined);
});

test('failed completion defaults its error and subscriber snapshots cannot mutate stored tasks', () => {
  const bt = createBackgroundTasks();
  bt.register({ id: 'a' });
  bt.onComplete((task) => {
    task.status = 'running';
    task.error = null;
  });

  const failed = mustTask(bt.complete('a', { ok: false }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'failed');
  assert.equal(mustTask(bt.get('a')).status, 'failed');
  assert.equal(mustTask(bt.get('a')).error, 'failed');

  bt.register({ id: 'b' });
  assert.equal(mustTask(bt.cancel('b')).completedAt != null, true);
  assert.equal(bt.list({ status: 'cancelled' }).length, 1);
});
