import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  present,
  recordValue,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

test('schedules: create cron + list + cancel + manual tick', async () => {
  const trustedRoot = tempRoot();
  const fired: string[] = [];
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async (record) => {
      fired.push(record.id);
      return { runId: `run_for_${record.id}` };
    },
  });
  const base = await bind(server);
  try {
    const listEmpty = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(listEmpty.status, 200);
    assert.equal(listEmpty.body.enabled, true);
    assert.equal(arrayField(listEmpty.body, 'schedules', 'empty schedule list').length, 0);

    const createCron = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-weekly' },
      body: { name: 'weekly', cron: '* * * * *', payload: { recipeId: 'meeting-actions' } },
    });
    assert.equal(createCron.status, 200);
    const createCronSchedule = objectField(createCron.body, 'schedule', 'created cron schedule');
    const scheduleId = stringField(createCronSchedule, 'id', 'created cron schedule id');
    assert.match(scheduleId, /^sched_/);
    assert.equal(createCronSchedule.tenantId, 'tenant_alice');

    const listOne = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    const schedules = arrayField(listOne.body, 'schedules', 'one schedule list');
    const firstSchedule = present(schedules[0], 'first listed schedule');
    assert.equal(schedules.length, 1);
    assert.equal(firstSchedule.name, 'weekly');

    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-weekly-tick' },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    assert.equal(fired.length, 1);

    const cancel = await jsonRequest(base, `/api/schedules/${scheduleId}/cancel`, {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-weekly-cancel' },
    });
    assert.equal(cancel.status, 200);
    assert.equal(objectField(cancel.body, 'schedule', 'cancelled schedule').status, 'cancelled');

    const remove = await jsonRequest(base, `/api/schedules/${scheduleId}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-weekly-remove' },
    });
    assert.equal(remove.status, 200);
    const afterRemove = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(arrayField(afterRemove.body, 'schedules', 'schedules after remove').length, 0);
  } finally {
    await close(server);
  }
});

test('schedules: one-shot fireAt creates schedule', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async () => ({ runId: 'r1' }),
  });
  const base = await bind(server);
  try {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-once' },
      body: { name: 'once', fireAt, payload: {} },
    });
    assert.equal(created.status, 200);
    const createdSchedule = objectField(created.body, 'schedule', 'created one-shot schedule');
    assert.equal(createdSchedule.kind, 'one-shot');
    assert.equal(createdSchedule.nextFireAt, fireAt);
  } finally {
    await close(server);
  }
});

test('schedules disabled returns 503 when enableScheduler:false', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const create = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      body: { name: 'noop', cron: '* * * * *' },
    });
    assert.equal(create.status, 503);
    assert.match(String(create.body.error), /Scheduler is not enabled/);
  } finally {
    await close(server);
  }
});

test('schedules reject malformed create bodies', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async () => ({ runId: 'r1' }),
  });
  const base = await bind(server);
  try {
    const badName = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-bad-name' },
      body: { name: '', cron: '* * * * *', payload: {} },
    });
    assert.equal(badName.status, 400);

    const badPayload = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-bad-payload' },
      body: { name: 'bad payload', cron: '* * * * *', payload: 'not-an-object' },
    });
    assert.equal(badPayload.status, 400);
  } finally {
    await close(server);
  }
});

test('scheduler default executor runs a recipe and records a run', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);
  try {
    // meeting-actions 配方现在要求可用来源:给计划任务也铺好会议纪要并显式传入。
    const sourcePath = path.join(trustedRoot, 'meeting-notes.md');
    fs.writeFileSync(sourcePath, '# 会议纪要\n- 跟进采购合同\n', 'utf8');
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-default-executor' },
      body: {
        name: '每周会议纪要',
        fireAt,
        payload: { recipeId: 'meeting-actions', prompt: '自动整理', files: [sourcePath] },
      },
    });
    assert.equal(created.status, 200);
    const defaultSchedule = objectField(created.body, 'schedule', 'default executor schedule');
    const scheduleId = stringField(defaultSchedule, 'id', 'default executor schedule id');

    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-default-tick' },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    const firstTickResult = present(arrayField(tick.body, 'results', 'default executor tick results')[0], 'first tick result');
    assert.ok(firstTickResult.runId, 'executor produced a runId');

    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    const indexedRuns = arrayField(index.body, 'runs', 'default executor indexed runs');
    const indexedScheduledRun = present(indexedRuns[0], 'first scheduled run');
    assert.equal(indexedRuns.length, 1);
    assert.equal(indexedScheduledRun.recipeId, 'meeting-actions');
    assert.equal(indexedScheduledRun.status, 'succeeded');
  } finally {
    await close(server);
  }
});
