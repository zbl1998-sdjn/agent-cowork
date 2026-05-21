// Integration smoke for the runtime features added in this round:
//   1) Memory routes: GET /api/memory, POST /api/memory/facts, POST /api/memory/notes,
//      GET /api/memory/notes/<name>.
//   2) Runs index: GET /api/runs/index — backed by RunsIndex with tenant scope.
//   3) Schedules: POST /api/schedules (cron + one-shot), GET /api/schedules,
//      POST /api/schedules/<id>/cancel, DELETE /api/schedules/<id>,
//      POST /api/schedules/_tick.
//
// The server is bound to 127.0.0.1:0 so each test gets a fresh ephemeral port.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runtime-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

test('memory routes: append fact, list notes, read back, inject in workspace info', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
  });
  const base = await bind(server);
  try {
    const empty = await jsonRequest(base, '/api/memory');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.memory.enabled, false);

    const factResp = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'k1' },
      body: { key: '客户简称', value: '阿里 = 阿里巴巴中国区运营' },
    });
    assert.equal(factResp.status, 200);
    assert.equal(factResp.body.fact.key, '客户简称');

    const filled = await jsonRequest(base, '/api/memory');
    assert.equal(filled.status, 200);
    assert.equal(filled.body.memory.enabled, true);
    assert.ok(filled.body.memory.text.includes('客户简称'));

    const noteResp = await jsonRequest(base, '/api/memory/notes', {
      method: 'POST',
      body: { name: 'projects.md', body: '# Projects\n- Alpha: launched\n' },
    });
    assert.equal(noteResp.status, 200);

    const noteRead = await jsonRequest(base, '/api/memory/notes/projects.md');
    assert.equal(noteRead.status, 200);
    assert.ok(noteRead.body.note.body.includes('Alpha'));

    const audit = path.join(trustedRoot, '.KimiCowork', 'audit', 'memory.jsonl');
    assert.ok(fs.existsSync(audit), 'memory audit JSONL must exist');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('memory routes reject invalid input', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const badFact = await jsonRequest(base, '/api/memory/facts', {
      method: 'POST',
      body: { key: '', value: 'x' },
    });
    assert.equal(badFact.status, 400);
    assert.match(badFact.body.error, /key is required/);

    const badNote = await jsonRequest(base, '/api/memory/notes', {
      method: 'POST',
      body: { name: '../escape.md', body: 'x' },
    });
    assert.equal(badNote.status, 400);
    assert.match(badNote.body.error, /Invalid memory note name/);

    const missing = await jsonRequest(base, '/api/memory/notes/missing.md');
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runs index: recipe-run upserts a tenant-scoped record', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const indexEmpty = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(indexEmpty.status, 200);
    assert.equal(indexEmpty.body.runs.length, 0);

    const recipeRun = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
      body: { prompt: '把会议纪要整理', files: [] },
    });
    assert.equal(recipeRun.status, 200);
    assert.ok(recipeRun.body.runId);

    const indexFilled = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(indexFilled.status, 200);
    assert.equal(indexFilled.body.runs.length, 1);
    assert.equal(indexFilled.body.runs[0].recipeId, 'meeting-actions');
    assert.equal(indexFilled.body.runs[0].status, 'succeeded');
    assert.equal(indexFilled.body.runs[0].tenantId, 'tenant_alice');

    const otherTenant = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_bob' },
    });
    assert.equal(otherTenant.body.runs.length, 0, 'tenant scoping must hold');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('recipe run endpoint replays duplicate idempotency key without creating a second run', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = {
      'x-tenant-id': 'tenant_alice',
      'x-user-id': 'user_alice',
      'idempotency-key': 'recipe-run-once',
    };
    const first = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers,
      body: { prompt: '把会议纪要整理', files: [] },
    });
    assert.equal(first.status, 200);
    assert.ok(first.body.runId);
    assert.equal(first.body.idempotentReplay, undefined);

    const second = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers,
      body: { prompt: '把会议纪要整理', files: [] },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, first.body.runId);

    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.stats.total, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('schedules: create cron + list + cancel + manual tick', async () => {
  const trustedRoot = tempRoot();
  const fired = [];
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
    assert.equal(listEmpty.body.schedules.length, 0);

    const createCron = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
      body: { name: 'weekly', cron: '* * * * *', payload: { recipeId: 'meeting-actions' } },
    });
    assert.equal(createCron.status, 200);
    const scheduleId = createCron.body.schedule.id;
    assert.match(scheduleId, /^sched_/);
    assert.equal(createCron.body.schedule.tenantId, 'tenant_alice');

    const listOne = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(listOne.body.schedules.length, 1);
    assert.equal(listOne.body.schedules[0].name, 'weekly');

    // Wait one minute would be excessive; bump nextFireAt into the past and tick.
    const file = path.join(trustedRoot, '.KimiCowork', 'schedules', `${scheduleId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', { method: 'POST' });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    assert.equal(fired.length, 1);

    // Cancel the schedule.
    const cancel = await jsonRequest(base, `/api/schedules/${scheduleId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.schedule.status, 'cancelled');

    // Removing it should also work.
    const remove = await jsonRequest(base, `/api/schedules/${scheduleId}`, { method: 'DELETE' });
    assert.equal(remove.status, 200);
    const afterRemove = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(afterRemove.body.schedules.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
      body: { name: 'once', fireAt, payload: {} },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.schedule.kind, 'one-shot');
    assert.equal(created.body.schedule.nextFireAt, fireAt);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
    assert.match(create.body.error, /Scheduler is not enabled/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE: /api/runs/:id/events replays a completed recipe run timeline', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice' },
      body: { prompt: '会议纪要整理', files: [] },
    });
    assert.equal(run.status, 200);
    const runId = run.body.runId;
    assert.ok(Array.isArray(run.body.events) && run.body.events.length > 0);

    // Connect to SSE; the run is already finished, so persisted events replay.
    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('event: assistant_end')) break;
    }
    controller.abort();

    assert.match(buffered, /event: user_message/);
    assert.match(buffered, /event: preview/);
    assert.match(buffered, /event: awaiting_approval/);
    assert.match(buffered, /event: assistant_end/);
    assert.match(buffered, /id: 1\n/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE: Last-Event-ID skips already-delivered events', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      body: { prompt: 'x', files: [] },
    });
    const runId = run.body.runId;
    const totalEvents = run.body.events.length;
    const lastSeq = run.body.events[1].seq; // skip first two

    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': String(lastSeq) },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('event: assistant_end')) break;
    }
    controller.abort();

    // Should not include the first event (seq 1) again.
    assert.ok(!buffered.includes('id: 1\n'), 'seq 1 must be skipped');
    assert.match(buffered, /event: assistant_end/);
    assert.ok(totalEvents > 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SSE: invalid run id returns 400', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/bad%2Fid/events`);
    assert.equal(res.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
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
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
      body: {
        name: '每周会议纪要',
        fireAt,
        payload: { recipeId: 'meeting-actions', prompt: '自动整理', files: [] },
      },
    });
    assert.equal(created.status, 200);
    const scheduleId = created.body.schedule.id;

    // Push nextFireAt into the past and tick.
    const file = path.join(trustedRoot, '.KimiCowork', 'schedules', `${scheduleId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', { method: 'POST' });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    assert.ok(tick.body.results[0].runId, 'executor produced a runId');

    // The produced run should appear in the tenant-scoped index.
    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice' },
    });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].recipeId, 'meeting-actions');
    assert.equal(index.body.runs[0].status, 'succeeded');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
