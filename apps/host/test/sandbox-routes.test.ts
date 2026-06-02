import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_ALLOW_TOOLS } from '../src/sandbox/index.js';
import { createServer } from '../src/server.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  stringField,
  tempRoot,
} from './helpers/host-http.js';
import { fakeProbeSpawnSync } from './helpers/sandbox.js';

test('GET /api/sandbox/info reports capabilities', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const info = await jsonRequest(base, '/api/sandbox/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.enabled, true);
    assert.equal(info.body.backend, 'local-subprocess');
    assert.deepEqual(info.body.allowTools, DEFAULT_ALLOW_TOOLS);
  } finally {
    await close(server);
  }
});

test('GET /api/sandbox/info exposes the startup isolation probe and docker selection', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    sandboxOptions: { image: 'python:3.12-slim' },
    sandboxProbeSpawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'docker image inspect python:3.12-slim': { stdout: '[]\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });
  const base = await bind(server);
  try {
    const info = await jsonRequest(base, '/api/sandbox/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.backend, 'vm:docker');
    assert.equal(info.body.networkIsolated, true);
    const startup = objectField(info.body, 'startup', 'sandbox startup');
    assert.equal(startup.selectedBackend, 'docker');
    assert.equal(startup.fallback, false);
  } finally {
    await close(server);
  }
});

test('GET /api/selfcheck warns when startup falls back to the local sandbox', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    sandboxProbeSpawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'docker unavailable' },
      'wsl.exe --status': { status: 1, stderr: 'wsl unavailable' },
    }),
  });
  const base = await bind(server);
  try {
    const selfcheck = await jsonRequest(base, '/api/selfcheck');
    assert.equal(selfcheck.status, 200);
    const sandbox = objectField(selfcheck.body, 'sandbox', 'selfcheck sandbox');
    assert.equal(sandbox.backend, 'local-subprocess');
    assert.equal(sandbox.networkIsolated, false);
    const sandboxCheck = arrayField(selfcheck.body, 'checks', 'selfcheck checks')
      .find((check) => check.id === 'sandbox-network-isolation');
    assert.ok(sandboxCheck, 'sandbox network isolation check should exist');
    assert.equal(sandboxCheck.status, 'warn');
    assert.match(stringField(sandboxCheck, 'detail', 'sandbox check detail'), /本地不隔离网络/);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/exec runs a tool, records a run, and is idempotent', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sbx-1' };
    const body = { spec: { tool: 'node', args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 5000 } };
    const first = await jsonRequest(base, '/api/sandbox/exec', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(objectField(first.body, 'result', 'sandbox exec result').exitCode, 0);
    assert.equal(objectField(first.body, 'result', 'sandbox exec result').stdout, 'ok');
    assert.match(stringField(first.body, 'runId', 'sandbox run id'), /^run_/);

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_alice' } });
    const runs = arrayField(index.body, 'runs', 'sandbox exec runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.type, 'sandbox-exec');

    const second = await jsonRequest(base, '/api/sandbox/exec', { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, first.body.runId);
    const indexAfter = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_alice' } });
    assert.equal(arrayField(indexAfter.body, 'runs', 'sandbox exec replayed runs').length, 1, 'replay must not create a second run');
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/exec rejects direct execution by default', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      headers: { 'idempotency-key': 'sbx-direct-blocked' },
      body: { spec: { tool: 'node', args: ['-e', 'process.stdout.write("blocked")'], timeoutMs: 1000 } },
    });
    assert.equal(res.status, 428);
    assert.match(String(res.body.error), /agent approval/i);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/exec rejects a tool outside the allowlist with 400', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      headers: { 'idempotency-key': 'sbx-bad' },
      body: { spec: { tool: 'curl', args: ['http://example.com'], timeoutMs: 1000 } },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /not in the allowlist/);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/exec rejects malformed route body before spec normalization', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      headers: { 'idempotency-key': 'sbx-malformed' },
      body: { spec: 'node' },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /object|spec/i);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/exec requires an Idempotency-Key', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      body: { spec: { tool: 'node', args: ['-e', ''], timeoutMs: 1000 } },
    });
    assert.equal(res.status, 428);
  } finally {
    await close(server);
  }
});
