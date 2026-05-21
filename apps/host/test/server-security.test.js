import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tempRoot(prefix = 'kcw-security-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address();
  return `http://${address}:${port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
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

test('API rejects cross-origin mutating requests and text/plain JSON bodies', async () => {
  const trustedRoot = tempRoot();
  const target = path.join(trustedRoot, 'csrf.txt');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const plain = await fetch(`${base}/api/file-ops/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'idempotency-key': 'plain-body',
      },
      body: JSON.stringify({
        trustedRoot,
        operations: [{ type: 'write', path: target, content: 'plain' }],
      }),
    });
    assert.equal(plain.status, 415);
    assert.equal(fs.existsSync(target), false);

    const crossOrigin = await jsonRequest(base, '/api/file-ops/apply', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'idempotency-key': 'cross-origin',
      },
      body: {
        trustedRoot,
        operations: [{ type: 'write', path: target, content: 'cross-origin' }],
      },
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(fs.existsSync(target), false);
  } finally {
    await close(server);
  }
});

test('request-supplied trustedRoot cannot escape configured workspace', async () => {
  const trustedRoot = tempRoot();
  const outsideRoot = tempRoot('kcw-outside-');
  const outsideSecret = path.join(outsideRoot, 'secret.txt');
  const outsideWrite = path.join(outsideRoot, 'write.txt');
  fs.writeFileSync(outsideSecret, 'outside-ok', 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const read = await jsonRequest(base, '/api/files/read', {
      method: 'POST',
      body: { trustedRoot: outsideRoot, path: outsideSecret },
    });
    assert.equal(read.status, 400);

    const bundle = await jsonRequest(base, '/api/context/bundle', {
      method: 'POST',
      body: { trustedRoot: outsideRoot, paths: [outsideSecret] },
    });
    assert.equal(bundle.status, 400);

    const preview = await jsonRequest(base, '/api/file-ops/preview', {
      method: 'POST',
      body: { trustedRoot: outsideRoot, operations: [{ type: 'write', path: outsideWrite, content: 'x' }] },
    });
    assert.equal(preview.status, 400);

    const apply = await jsonRequest(base, '/api/file-ops/apply', {
      method: 'POST',
      headers: { 'idempotency-key': 'escape-apply' },
      body: { trustedRoot: outsideRoot, operations: [{ type: 'write', path: outsideWrite, content: 'x' }] },
    });
    assert.equal(apply.status, 400);
    assert.equal(fs.existsSync(outsideWrite), false);
  } finally {
    await close(server);
  }
});

test('run detail, task list, run list, and SSE history are tenant scoped', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const run = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_a',
        'x-user-id': 'user_a',
        'idempotency-key': 'tenant-a-run',
      },
      body: { prompt: 'secret a', files: [] },
    });
    assert.equal(run.status, 200);
    const runId = run.body.runId;

    const otherDetail = await jsonRequest(base, `/api/runs/${encodeURIComponent(runId)}`, {
      headers: { 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
    });
    assert.equal(otherDetail.status, 404);

    const otherRuns = await jsonRequest(base, '/api/runs', {
      headers: { 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
    });
    assert.equal(otherRuns.status, 200);
    assert.deepEqual(otherRuns.body.runs, []);

    const otherTasks = await jsonRequest(base, '/api/tasks', {
      headers: { 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
    });
    assert.equal(otherTasks.status, 200);
    assert.deepEqual(otherTasks.body.tasks, []);

    const controller = new AbortController();
    const events = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { accept: 'text/event-stream', 'x-tenant-id': 'tenant_b', 'x-user-id': 'user_b' },
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(events.status, 404);
  } finally {
    await close(server);
  }
});

test('critical writes require Idempotency-Key and reject same key with different body', async () => {
  const trustedRoot = tempRoot();
  const target = path.join(trustedRoot, 'apply.txt');
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);
  try {
    const recipeMissing = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      body: { prompt: 'missing key', files: [] },
    });
    assert.equal(recipeMissing.status, 428);

    const applyMissing = await jsonRequest(base, '/api/file-ops/apply', {
      method: 'POST',
      body: { trustedRoot, operations: [{ type: 'write', path: target, content: 'x' }] },
    });
    assert.equal(applyMissing.status, 428);
    assert.equal(fs.existsSync(target), false);

    const scheduleMissing = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      body: { name: 'once', fireAt: new Date(Date.now() + 60_000).toISOString(), payload: {} },
    });
    assert.equal(scheduleMissing.status, 428);

    const first = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'same-key' },
      body: { prompt: 'first body', files: [] },
    });
    assert.equal(first.status, 200);

    const replay = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'same-key' },
      body: { prompt: 'first body', files: [] },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.runId, first.body.runId);

    const mismatch = await jsonRequest(base, '/api/recipes/meeting-actions/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'same-key' },
      body: { prompt: 'different body', files: [] },
    });
    assert.equal(mismatch.status, 409);
    assert.match(mismatch.body.error, /reused/i);
  } finally {
    await close(server);
  }
});
