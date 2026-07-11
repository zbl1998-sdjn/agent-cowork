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
  stringField,
  tempRoot,
} from './helpers/host-http.js';

test('POST /api/sandbox/run-code runs inline code, writes the script, records a sandbox-code run, and is idempotent', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_carol', 'x-user-id': 'user_carol', 'idempotency-key': 'code-1' };
    const body = { tool: 'node', code: 'process.stdout.write("from-script:" + (2 + 3))', prompt: 'add two numbers' };
    const first = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    const firstResult = objectField(first.body, 'result', 'first run-code result');
    assert.equal(firstResult.exitCode, 0);
    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.stdout, 'from-script:5');
    assert.match(stringField(first.body, 'runId', 'run-code run id'), /^run_/);
    const script = stringField(first.body, 'script', 'run-code script');
    assert.match(script, /^\.AgentCowork\/scripts\/run_[^/]+\.js$/);

    const scriptPath = path.join(trustedRoot, ...script.split('/'));
    assert.equal(fs.existsSync(scriptPath), true, 'script file should be written under the trusted root');

    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_carol', 'x-user-id': 'user_carol' },
    });
    const runs = arrayField(index.body, 'runs', 'run-code runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.type, 'sandbox-code');

    const second = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, first.body.runId);
    const indexAfter = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_carol', 'x-user-id': 'user_carol' },
    });
    assert.equal(arrayField(indexAfter.body, 'runs', 'run-code replayed runs').length, 1, 'replay must not create a second run');
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code rejects direct execution by default', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'sbx-code-direct-blocked' },
      body: { tool: 'node', code: 'process.stdout.write("blocked")' },
    });
    assert.equal(res.status, 428);
    assert.match(String(res.body.error), /agent approval/i);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code records a failed run when the script exits non-zero', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_dan', 'idempotency-key': 'code-fail' };
    const body = { tool: 'node', code: 'process.stderr.write("boom"); process.exit(3)' };
    const res = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(res.status, 200);
    const result = objectField(res.body, 'result', 'failed run-code result');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, 'boom');

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_dan' } });
    const runs = arrayField(index.body, 'runs', 'failed run-code runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'failed');
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code rejects a tool outside the allowlist with 400 and writes no script', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'code-bad' },
      body: { tool: 'ruby', code: 'puts 1' },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /not in the allowlist/);
    const scriptsDir = path.join(trustedRoot, '.AgentCowork', 'scripts');
    const wrote = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
    assert.equal(wrote.length, 0, 'an invalid tool must not leave a script behind');
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code rejects malformed route body before writing a script', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'code-malformed' },
      body: { tool: 42, code: 'process.stdout.write("x")' },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /string|tool/i);
    const scriptsDir = path.join(trustedRoot, '.AgentCowork', 'scripts');
    assert.equal(fs.existsSync(scriptsDir), false);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code requires an Idempotency-Key', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      body: { tool: 'node', code: 'process.stdout.write("x")' },
    });
    assert.equal(res.status, 428);
  } finally {
    await close(server);
  }
});

test('POST /api/sandbox/run-code rejects an empty code body with 400', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const server = createServer({ trustedRoot, enableScheduler: false, allowUnsafeDirectSandboxRoutes: true });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'code-empty' },
      body: { tool: 'node', code: '   ' },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /code is required/);
  } finally {
    await close(server);
  }
});
