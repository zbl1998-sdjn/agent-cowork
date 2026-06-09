import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  present,
  readableBody,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

test('SSE: /api/runs/:id/events replays a completed recipe run timeline', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/email-draft/run', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sse-run' },
      body: { prompt: '会议纪要整理', files: [] },
    });
    assert.equal(run.status, 200);
    const runId = stringField(run.body, 'runId', 'SSE run id');
    assert.ok(arrayField(run.body, 'events', 'SSE run events').length > 0);

    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream', 'x-tenant-id': 'tenant_alice' },
      signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const reader = readableBody(res, 'run events response').getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('event: assistant_end')) {
        break;
      }
    }
    controller.abort();

    assert.match(buffered, /event: user_message/);
    assert.match(buffered, /event: preview/);
    assert.match(buffered, /event: awaiting_approval/);
    assert.match(buffered, /event: assistant_end/);
    assert.match(buffered, /id: 1\n/);
  } finally {
    await close(server);
  }
});

test('SSE: Last-Event-ID skips already-delivered events', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/email-draft/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'sse-last-event-id' },
      body: { prompt: 'x', files: [] },
    });
    const runId = stringField(run.body, 'runId', 'Last-Event-ID run id');
    const runEvents = arrayField(run.body, 'events', 'Last-Event-ID run events');
    const totalEvents = runEvents.length;
    const lastSeq = present(runEvents[1], 'second run event').seq;

    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { accept: 'text/event-stream', 'last-event-id': String(lastSeq) },
      signal: controller.signal,
    });
    const reader = readableBody(res, 'last-event-id response').getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      if (buffered.includes('event: assistant_end')) {
        break;
      }
    }
    controller.abort();

    assert.ok(!buffered.includes('id: 1\n'), 'seq 1 must be skipped');
    assert.match(buffered, /event: assistant_end/);
    assert.ok(totalEvents > 2);
  } finally {
    await close(server);
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
    await close(server);
  }
});

test('run detail invalid run id returns 400', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/bad%2Fid`);
    assert.equal(res.status, 400);
  } finally {
    await close(server);
  }
});

test('run list endpoints reject malformed query filters', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const tasks = await jsonRequest(base, '/api/tasks?limit=0');
    assert.equal(tasks.status, 400);

    const runs = await jsonRequest(base, '/api/runs?limit=not-a-number');
    assert.equal(runs.status, 400);

    const index = await jsonRequest(base, '/api/runs/index?status=bad/status');
    assert.equal(index.status, 400);
  } finally {
    await close(server);
  }
});
