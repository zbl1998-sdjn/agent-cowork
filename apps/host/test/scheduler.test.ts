import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCron, nextFireAt, describeCron } from '../src/runtime/cron.js';
import { Scheduler, type ScheduleRecord } from '../src/runtime/scheduler.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sched-'));
}

function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

function scheduleAttempts(record: { attempts?: unknown }, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(record.attempts), `${label} should expose an attempts array`);
  return record.attempts.map((attempt, index) => {
    assert.ok(attempt && typeof attempt === 'object' && !Array.isArray(attempt), `${label}[${index}] should be an object`);
    return attempt as Record<string, unknown>;
  });
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
  assert.deepEqual(scheduleAttempts(record, 'new schedule attempts'), []);
  assert.equal(calls, 0);
  const reloaded = present(scheduler.get(record.id), 'reloaded schedule');
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
  assert.throws(
    () => scheduler.create({ name: 'x', fireAt: '2000-01-01T00:00:00Z', tenantId: 't', userId: 'u' }),
    /future ISO/,
  );
  assert.throws(
    () => scheduler.create({ name: 'x', tenantId: 't', userId: 'u' }),
    /cron or fireAt/,
  );
  assert.throws(
    () => scheduler.create({ cron: '0 9 * * 1', tenantId: 't', userId: 'u' }),
    /name is required/,
  );
});

test('Scheduler requires a complete canonical owner for every new schedule', () => {
  const scheduler = new Scheduler({ storeDir: tempRoot(), executor: async () => ({}) });
  const future = new Date(Date.now() + 60_000).toISOString();
  for (const owner of [
    { tenantId: 'tenant_a' },
    { userId: 'user_a' },
    { tenantId: ' tenant_a', userId: 'user_a' },
  ]) {
    assert.throws(
      () => scheduler.create({ name: 'invalid owner', fireAt: future, ...owner }),
      /canonical tenantId and userId/i,
    );
  }
});

test('Scheduler.start reports tick rejection without propagating logger failures', async () => {
  const events: Array<{ event: string; payload: Record<string, unknown> | undefined }> = [];
  const scheduler = new Scheduler({
    store: {
      list: () => { throw new Error('tick secret'); },
      get: () => null,
      save: (value) => value,
      remove: () => false,
    },
    executor: async () => ({}),
    tickIntervalMs: 1000,
    logger: (event, payload) => {
      events.push({ event, payload });
      throw new Error('logger failed');
    },
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 1050));
  scheduler.stop();
  assert.deepEqual(events, [{ event: 'scheduler.tick_failed', payload: undefined }]);
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
  const firstNext = present(record.nextFireAt, 'initial nextFireAt');
  // Advance "now" past nextFireAt.
  nowMs = Date.parse(firstNext) + 30 * 1000;
  const due = scheduler.pickDue();
  assert.equal(due.length, 1);
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(present(results[0], 'first tick result').ok, true);
  assert.equal(fired.length, 1);
  const after = present(scheduler.get(record.id), 'schedule after tick');
  assert.equal(after.status, 'pending');
  assert.ok(Date.parse(present(after.nextFireAt, 'next fire after tick')) > Date.parse(firstNext));
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
  const after = present(sched2.get(record.id), 'one-shot schedule after tick');
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
  const after = present(scheduler.get(record.id), 'cancelled schedule');
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
  nowMs = Date.parse(present(record.nextFireAt, 'error schedule nextFireAt')) + 1000;
  const results = await scheduler.tickOnce();
  assert.equal(results.length, 1);
  assert.equal(present(results[0], 'error tick result').ok, false);
  const after = present(scheduler.get(record.id), 'schedule after error');
  assert.equal(after.status, 'pending');
  assert.match(present(after.lastError, 'last error'), /synthetic failure/);
  assert.equal(after.runs, 1);
});

test('Scheduler appends immutable success/failure attempts and keeps lastRunId as the latest success', async () => {
  const root = tempRoot();
  let nowMs = new Date('2026-05-18T08:59:00.000Z').getTime();
  let invocation = 0;
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => {
      invocation += 1;
      if (invocation === 1) return { runId: 'run_success' };
      throw new Error('second attempt failed');
    },
    now: () => new Date(nowMs),
  });
  const created = scheduler.create({
    name: 'attempt history',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });

  nowMs = Date.parse(present(created.nextFireAt, 'first attempt nextFireAt')) + 1_000;
  await scheduler.tickOnce();
  const afterSuccess = present(scheduler.get(created.id), 'schedule after successful attempt');
  const successAttempts = scheduleAttempts(afterSuccess, 'successful attempts');
  assert.equal(successAttempts.length, 1);
  assert.match(String(successAttempts[0]?.attemptId), /^attempt_/);
  assert.equal(successAttempts[0]?.status, 'succeeded');
  assert.equal(successAttempts[0]?.runId, 'run_success');
  assert.equal(successAttempts[0]?.error, null);
  assert.equal(successAttempts[0]?.trigger, 'scheduled');
  assert.equal(afterSuccess.lastRunId, 'run_success');

  nowMs = Date.parse(present(afterSuccess.nextFireAt, 'second attempt nextFireAt')) + 1_000;
  await scheduler.tickOnce();
  const afterFailure = present(scheduler.get(created.id), 'schedule after failed attempt');
  const attempts = scheduleAttempts(afterFailure, 'success and failure attempts');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.attemptId, successAttempts[0]?.attemptId, 'existing entries must remain unchanged');
  assert.match(String(attempts[1]?.attemptId), /^attempt_/);
  assert.notEqual(attempts[1]?.attemptId, attempts[0]?.attemptId);
  assert.equal(attempts[1]?.status, 'failed');
  assert.equal(attempts[1]?.runId, null);
  assert.match(String(attempts[1]?.error), /second attempt failed/);
  assert.equal(attempts[1]?.trigger, 'scheduled');
  assert.equal(afterFailure.lastRunId, 'run_success', 'a failed attempt must not overwrite the latest successful run id');
});

test('Scheduler retains only the latest 20 append-only attempts', async () => {
  const root = tempRoot();
  let nowMs = new Date('2026-05-18T08:59:00.000Z').getTime();
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'run_latest' }),
    now: () => new Date(nowMs),
  });
  const created = scheduler.create({
    name: 'bounded history',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });
  const seededAttempts = Array.from({ length: 20 }, (_, index) => ({
    attemptId: `attempt_seed_${index}`,
    startedAt: new Date(nowMs + index).toISOString(),
    finishedAt: new Date(nowMs + index + 1).toISOString(),
    status: 'succeeded' as const,
    runId: `run_seed_${index}`,
    error: null,
    trigger: 'scheduled' as const,
  }));
  nowMs = Date.parse(present(created.nextFireAt, 'bounded history nextFireAt')) + 1_000;
  scheduler.store.save({ ...created, attempts: seededAttempts, nextFireAt: new Date(nowMs - 1).toISOString() });

  await scheduler.tickOnce();

  const after = present(scheduler.get(created.id), 'bounded attempt schedule');
  const attempts = scheduleAttempts(after, 'bounded attempts');
  assert.equal(attempts.length, 20);
  assert.equal(attempts[0]?.attemptId, 'attempt_seed_1', 'retention must remove only the oldest entry');
  assert.match(String(attempts[19]?.attemptId), /^attempt_/);
  assert.equal(attempts[19]?.runId, 'run_latest');
});

test('Scheduler normalises legacy and over-limit histories at every store read boundary', () => {
  const records = new Map<string, ScheduleRecord>();
  const scheduler = new Scheduler({
    store: {
      list: () => [...records.values()],
      get: (id) => records.get(id) || null,
      save: (record) => {
        records.set(record.id, record);
        return record;
      },
      remove: (id) => records.delete(id),
    },
    executor: async () => ({ runId: 'run_unused' }),
    now: () => new Date('2026-05-18T08:59:00.000Z'),
  });
  const legacy = scheduler.create({
    name: 'legacy history',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });
  const legacyWithoutAttempts = { ...legacy };
  delete legacyWithoutAttempts.attempts;
  records.set(legacy.id, legacyWithoutAttempts);
  const bounded = scheduler.create({
    name: 'over-limit history',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });
  records.set(bounded.id, {
    ...bounded,
    attempts: Array.from({ length: 21 }, (_, index) => ({
      attemptId: `attempt_read_${index}`,
      startedAt: new Date(Date.UTC(2026, 4, 18, 9, 0, index)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 4, 18, 9, 0, index, 1)).toISOString(),
      status: 'succeeded' as const,
      runId: `run_read_${index}`,
      error: null,
      trigger: 'scheduled' as const,
    })),
  });

  assert.deepEqual(scheduleAttempts(present(scheduler.get(legacy.id), 'legacy read'), 'legacy read attempts'), []);
  const boundedAttempts = scheduleAttempts(present(scheduler.get(bounded.id), 'bounded read'), 'bounded read attempts');
  assert.equal(boundedAttempts.length, 20);
  assert.equal(boundedAttempts[0]?.attemptId, 'attempt_read_1');
  const listed = scheduler.list({ tenantId: 'tenant_attempts', userId: 'user_attempts' });
  assert.deepEqual(scheduleAttempts(present(listed.find((record) => record.id === legacy.id), 'listed legacy'), 'listed legacy attempts'), []);
  assert.equal(scheduleAttempts(present(listed.find((record) => record.id === bounded.id), 'listed bounded'), 'listed bounded attempts').length, 20);
});

test('Scheduler fails closed when stored attempt history is malformed', () => {
  const records = new Map<string, ScheduleRecord>();
  const scheduler = new Scheduler({
    store: {
      list: () => [...records.values()],
      get: (id) => records.get(id) || null,
      save: (record) => {
        records.set(record.id, record);
        return record;
      },
      remove: (id) => records.delete(id),
    },
    executor: async () => ({ runId: 'run_unused' }),
    now: () => new Date('2026-05-18T08:59:00.000Z'),
  });
  const baseline = scheduler.create({
    name: 'malformed attempt baseline',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });
  records.delete(baseline.id);
  const validAttempt = {
    attemptId: 'attempt_valid',
    startedAt: '2026-05-18T09:00:00.000Z',
    finishedAt: '2026-05-18T09:00:01.000Z',
    status: 'succeeded',
    runId: 'run_valid',
    error: null,
    trigger: 'scheduled',
  };
  const invalidHistories: unknown[] = [
    'not-an-array',
    [{ ...validAttempt, attemptId: 'invalid' }],
    [{ ...validAttempt, startedAt: '2026-05-18T09:00:00Z' }],
    [{ ...validAttempt, finishedAt: '2026-05-18T08:59:59.000Z' }],
    [{ ...validAttempt, status: 'running' }],
    [{ ...validAttempt, trigger: 'manual' }],
    [{ ...validAttempt, runId: `run_${'x'.repeat(129)}` }],
    [{ ...validAttempt, error: 'unexpected-on-success' }],
    [{ ...validAttempt, status: 'failed', runId: 'run_failed', error: 'failed' }],
    [{ ...validAttempt, status: 'failed', runId: null, error: 'x'.repeat(1025) }],
    [{ ...validAttempt, extra: true }],
    [validAttempt, { ...validAttempt }],
  ];
  for (const [index, attempts] of invalidHistories.entries()) {
    const id = `sched_malformed_${index}`;
    records.set(id, { ...baseline, id, attempts } as unknown as ScheduleRecord);
    assert.equal(scheduler.get(id), null, `malformed history ${index} must fail closed on get`);
  }
  assert.deepEqual(scheduler.list(), [], 'malformed histories must fail closed on list');
});

test('Scheduler rejects malformed executor run ids without poisoning persisted history', async () => {
  const root = tempRoot();
  let nowMs = new Date('2026-05-18T08:59:00.000Z').getTime();
  const scheduler = new Scheduler({
    storeDir: root,
    executor: async () => ({ runId: 'run/invalid' }),
    now: () => new Date(nowMs),
  });
  const created = scheduler.create({
    name: 'invalid executor run id',
    cron: '* * * * *',
    tenantId: 'tenant_attempts',
    userId: 'user_attempts',
  });
  nowMs = Date.parse(present(created.nextFireAt, 'invalid run id next fire')) + 1_000;

  const result = present((await scheduler.tickOnce())[0], 'invalid run id tick result');

  assert.equal(result.ok, false);
  const after = present(scheduler.get(created.id), 'schedule after invalid executor run id');
  const attempts = scheduleAttempts(after, 'invalid executor run id attempts');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.status, 'failed');
  assert.equal(attempts[0]?.runId, null);
  assert.match(String(attempts[0]?.error), /invalid schedule attempt/i);
  assert.equal(after.lastRunId, null);
});
