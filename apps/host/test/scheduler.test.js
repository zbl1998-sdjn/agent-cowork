import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCron, nextFireAt, describeCron } from '../src/runtime/cron.js';
import { Scheduler } from '../src/runtime/scheduler.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sched-'));
}

test('parseCron accepts standard 5-field expressions', () => {
  const parsed = parseCron('0 9 * * 1');
  assert.ok(parsed.minute.has(0));
  assert.ok(parsed.hour.has(9));
  assert.ok(parsed.dayOfWeek.has(1));
});

test('parseCron rejects bad shapes', () => {
  assert.throws(() => parseCron('0 9 * *'), /5 fields/);
  assert.throws(() => parseCron('* * * * 9'), /out-of-range/);
  assert.throws(() => parseCron('0 25 * * *'), /out-of-range/);
  assert.throws(() => parseCron('*/0 * * * *'), /step must be positive/);
});

test('nextFireAt finds the next minute matching the spec', () => {
  // Monday 9am from a Sunday afternoon should be the next 9:00 on Monday.
  const from = new Date('2026-05-17T15:00:00');
  const next = nextFireAt('0 9 * * 1', from);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.ok(next.getTime() > from.getTime());
});

test('nextFireAt advances at least a minute when cron matches current minute', () => {
  const from = new Date('2026-05-20T09:00:00');
  const next = nextFireAt('0 9 * * *', from);
  // It should be next day 09:00, not the same minute again.
  assert.ok(next.getTime() > from.getTime());
});

test('describeCron returns friendly hint for common shapes', () => {
  assert.equal(describeCron('0 9 * * 1'), '每周一上午 9:00');
  assert.equal(describeCron('0 8 * * *'), '每天 08:00');
  assert.match(describeCron('invalid'), /invalid:/);
});

test('Scheduler.create persists a cron schedule with computed nextFireAt', () => {
  const root = tempRoot();
  let calls = 0;
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => {
      calls += 1;
      return { runId: 'run_test' };
    },
    now: () => new Date('2026-05-17T15:00:00'),
  });
  const record = scheduler.create({
    name: '每周一周报',
    cron: '0 9 * * 1',
    tenantId: 'tenant_alice',
    userId: 'user_alice',
    traceId: 'trace_1',
    payload: { recipeId: 'meeting-actions' },
  });
  assert.match(record.id, /^sched_/);
  assert.equal(record.tenantId, 'tenant_alice');
  assert.equal(record.status, 'pending');
  assert.equal(record.cronHuman, '每周一上午 9:00');
  assert.ok(record.nextFireAt);
  assert.equal(calls, 0);
  const reloaded = scheduler.get(record.id);
  assert.equal(reloaded.id, record.id);
});

test('Scheduler.create supports one-shot fireAt', () => {
  const root = tempRoot();
  const scheduler = new Scheduler({ storeDir: root, executor: async () => ({}) });
  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const record = scheduler.create({
    name: 'one-shot',
    fireAt: future,
    tenantId: 't',
    userId: 'u',
  });
  assert.equal(record.kind, 'one-shot');
  assert.equal(record.nextFireAt, future);
});

test('Scheduler rejects past fireAt and missing schedule spec', () => {
  const root = tempRoot();
  const scheduler = new Scheduler({ storeDir: root, executor: async () => ({}) });
  assert.throws(() => scheduler.create({ name: 'x', fireAt: '2000-01-01T00:00:00Z' }), /future ISO/);
  assert.throws(() => scheduler.create({ name: 'x' }), /cron or fireAt/);
  assert.throws(() => scheduler.create({ cron: '0 9 * * 1' }), /name is required/);
});

test('Scheduler.pickDue + tickOnce fires due cron jobs and advances nextFireAt', async () => {
  const root = tempRoot();
  let nowMs = new Date('2026-05-18T08:59:00').getTime();
  const fired = [];
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async (record) => {
      fired.push(record.id);
      return { runId: `run_${record.id}` };
    },
    now: () => new Date(nowMs),
  });
  const record = scheduler.create({
    name: 'weekly',
    cron: '0 9 * * 1',
    tenantId: 't',
    userId: 'u',
  });
  // Initial nextFireAt is Monday 09:00 of the surrounding week.
  const firstNext = record.nextFireAt;
  // Advance "now" past nextFireAt.
  nowMs = Date.parse(firstNext) + 30 * 1000;
  const due = scheduler.pickDue();
  assert.equal(due.length, 1);
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(fired.length, 1);
  const after = scheduler.get(record.id);
  assert.equal(after.status, 'pending');
  assert.ok(Date.parse(after.nextFireAt) > Date.parse(firstNext));
  assert.equal(after.runs, 1);
  assert.equal(after.lastRunId, `run_${record.id}`);
});

test('Scheduler one-shot completes after firing', async () => {
  const root = tempRoot();
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'r1' }),
    now: () => new Date(),
  });
  const fireAt = new Date(Date.now() + 60_000).toISOString();
  const record = scheduler.create({ name: 'once', fireAt, tenantId: 't', userId: 'u' });
  // Manually advance by tickOnce with an adjusted "now": rebuild Scheduler.
  const sched2 = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'r1' }),
    now: () => new Date(Date.parse(fireAt) + 1000),
  });
  await sched2.tickOnce();
  const after = sched2.get(record.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.nextFireAt, null);
});

test('Scheduler.cancel marks the schedule cancelled and stops it firing', async () => {
  const root = tempRoot();
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'never' }),
    now: () => new Date(),
  });
  const fireAt = new Date(Date.now() + 60_000).toISOString();
  const record = scheduler.create({ name: 'once', fireAt, tenantId: 't', userId: 'u' });
  assert.equal(scheduler.cancel(record.id), true);
  const after = scheduler.get(record.id);
  assert.equal(after.status, 'cancelled');
  // Advance "now" past fireAt; pickDue should return nothing because cancelled.
  const sched2 = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'never' }),
    now: () => new Date(Date.parse(fireAt) + 1000),
  });
  const due = sched2.pickDue();
  assert.equal(due.length, 0);
});

test('Scheduler executor errors land in lastError but record stays pending for cron', async () => {
  const root = tempRoot();
  let nowMs = new Date('2026-05-18T08:59:00').getTime();
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => {
      throw new Error('synthetic failure');
    },
    now: () => new Date(nowMs),
  });
  const record = scheduler.create({
    name: 'always',
    cron: '* * * * *',
    tenantId: 't',
    userId: 'u',
  });
  nowMs = Date.parse(record.nextFireAt) + 1000;
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  const after = scheduler.get(record.id);
  assert.equal(after.status, 'pending');
  assert.match(after.lastError, /synthetic failure/);
  assert.equal(after.runs, 1);
});
