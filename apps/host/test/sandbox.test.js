import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { VmSandbox } from '../src/sandbox/vm-sandbox.js';
import { createSandbox, DEFAULT_ALLOW_TOOLS } from '../src/sandbox/index.js';
import { createServer } from '../src/server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-sbx-'));
}

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ---- spec validation ----

test('normalizeSandboxSpec applies safe defaults for a valid spec', () => {
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'process.stdout.write("a b")'] });
  assert.equal(spec.tool, 'node');
  assert.deepEqual(spec.args, ['-e', 'process.stdout.write("a b")']);
  assert.equal(spec.network, false, 'network defaults off');
  assert.ok(spec.timeoutMs > 0);
  assert.ok(spec.maxOutputBytes > 0);
});

test('normalizeSandboxSpec rejects unsafe / malformed specs', () => {
  assert.throws(() => normalizeSandboxSpec({}), /tool is required/);
  assert.throws(() => normalizeSandboxSpec({ tool: '/usr/bin/node' }), /bare command name/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node; rm -rf' }), /bare command name/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node', args: 'oops' }), /args must be an array/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node', timeoutMs: -1 }), /positive number/);
});

test('normalizeSandboxSpec enforces the tool allowlist when provided', () => {
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'curl' }, { allowTools: ['node', 'python3'] }),
    /not in the allowlist/,
  );
  const ok = normalizeSandboxSpec({ tool: 'node' }, { allowTools: ['node'] });
  assert.equal(ok.tool, 'node');
});

test('normalizeSandboxSpec clamps timeout to the configured maximum', () => {
  const spec = normalizeSandboxSpec({ tool: 'node', timeoutMs: 9_999_999 }, { maxTimeoutMs: 5000 });
  assert.equal(spec.timeoutMs, 5000);
});

test('normalizeSandboxSpec rejects non-allowlisted env keys', () => {
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'node', env: { SECRET: 'x' } }, { allowEnv: ['LANG'] }),
    /not in the allowlist/,
  );
  const ok = normalizeSandboxSpec({ tool: 'node', env: { LANG: 'C' } }, { allowEnv: ['LANG'] });
  assert.deepEqual(ok.env, { LANG: 'C' });
});

// ---- local subprocess adapter ----

test('LocalSubprocessSandbox runs a tool and captures stdout + exit code', async () => {
  const root = tempRoot();
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'process.stdout.write("hello")'], timeoutMs: 5000 });
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((w) => /network isolation/.test(w)));
});

test('LocalSubprocessSandbox enforces the timeout', async () => {
  const root = tempRoot();
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 300 });
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.timedOut, true);
});

test('LocalSubprocessSandbox caps output and flags truncation', async () => {
  const root = tempRoot();
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    { tool: 'node', args: ['-e', 'process.stdout.write("x".repeat(5000))'], timeoutMs: 5000 },
    { defaultMaxOutputBytes: 100 },
  );
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 100);
});

test('LocalSubprocessSandbox requires a trusted root', async () => {
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', ''], timeoutMs: 1000 });
  await assert.rejects(() => sandbox.exec(spec, {}), /trustedRoot is required/);
});

// ---- vm adapter contract ----

test('VmSandbox fails fast (501) when not provisioned, but can plan', () => {
  const sandbox = createSandbox({ backend: 'docker' });
  assert.equal(sandbox instanceof VmSandbox, true);
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 1000 });
  const plan = sandbox.plan(spec, { trustedRoot: '/work/root' });
  assert.ok(plan.argv.includes('--network=none'), 'docker plan defaults to no network');
  assert.equal(plan.networkIsolated, true);
});

test('VmSandbox.exec rejects with 501 until a runner is injected', async () => {
  const sandbox = new VmSandbox({ backend: 'docker' });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => sandbox.exec(spec, { trustedRoot: tempRoot() }), /not provisioned/);
});

// ---- route integration ----

test('GET /api/sandbox/info reports capabilities', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const info = await jsonRequest(base, '/api/sandbox/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.enabled, true);
    assert.equal(info.body.backend, 'local-subprocess');
    assert.deepEqual(info.body.allowTools, DEFAULT_ALLOW_TOOLS);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/exec runs a tool, records a run, and is idempotent', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sbx-1' };
    const body = { spec: { tool: 'node', args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 5000 } };
    const first = await jsonRequest(base, '/api/sandbox/exec', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(first.body.result.exitCode, 0);
    assert.equal(first.body.result.stdout, 'ok');
    assert.match(first.body.runId, /^run_/);

    // recorded + tenant-scoped in the runs index
    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_alice' } });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].type, 'sandbox-exec');

    // idempotent replay
    const second = await jsonRequest(base, '/api/sandbox/exec', { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, first.body.runId);
    const indexAfter = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_alice' } });
    assert.equal(indexAfter.body.runs.length, 1, 'replay must not create a second run');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/exec rejects a tool outside the allowlist with 400', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      headers: { 'idempotency-key': 'sbx-bad' },
      body: { spec: { tool: 'curl', args: ['http://example.com'], timeoutMs: 1000 } },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not in the allowlist/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/exec requires an Idempotency-Key', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/exec', {
      method: 'POST',
      body: { spec: { tool: 'node', args: ['-e', ''], timeoutMs: 1000 } },
    });
    assert.equal(res.status, 428);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- real WSL/Docker runner (deterministic via fake spawn) ----

import { EventEmitter } from 'node:events';
import { createWslDockerRunner } from '../src/sandbox/wsl-docker-runner.js';

function fakeSpawn(captured, { stdout = '', exitCode = 0 } = {}) {
  return (command, args) => {
    captured.command = command;
    captured.args = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode, null);
    });
    return child;
  };
}

test('createWslDockerRunner builds an isolated docker command line', async () => {
  const captured = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: 'python:3.12-slim', spawn: fakeSpawn(captured, { stdout: 'done' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = await runner(null, spec, { trustedRoot: '/work/root' });
  assert.equal(captured.command, 'docker');
  assert.ok(captured.args.includes('--network=none'), 'no-network by default');
  assert.ok(captured.args.includes('-v') && captured.args.includes('/work/root:/work'), 'workspace mounted');
  assert.deepEqual(captured.args.slice(-4), ['python:3.12-slim', 'python3', '-c', 'print(1)']);
  assert.equal(result.networkIsolated, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
  assert.equal(result.backend, 'vm:docker');
});

test('createWslDockerRunner honours network:true with bridge networking', async () => {
  const captured = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: 'node:20', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', ''], timeoutMs: 1000, network: true });
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.ok(captured.args.includes('--network=bridge'));
  assert.equal(result.networkIsolated, false);
});

test('createWslDockerRunner builds a wsl command and warns about network', async () => {
  const captured = {};
  const runner = createWslDockerRunner({ backend: 'wsl', distro: 'Ubuntu', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'pass'], timeoutMs: 1000 });
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.equal(captured.command, 'wsl.exe');
  assert.deepEqual(captured.args, ['-d', 'Ubuntu', '--', 'python3', '-c', 'pass']);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((w) => /network/.test(w)));
});

test('docker runner fails fast (501) when no image is configured', async () => {
  const runner = createWslDockerRunner({ backend: 'docker', spawn: fakeSpawn({}) });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => runner(null, spec, { trustedRoot: '/root' }), /requires an image/);
});

test('createSandbox provisions a docker VM sandbox when given an image + spawn', async () => {
  const captured = {};
  const sandbox = createSandbox({ backend: 'docker', image: 'python:3.12-slim', spawn: fakeSpawn(captured, { stdout: 'vm-ok' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = await sandbox.exec(spec, { trustedRoot: '/work/root' });
  assert.equal(result.stdout, 'vm-ok');
  assert.equal(result.networkIsolated, true);
  assert.equal(captured.command, 'docker');
});

// ---- inline code runner (POST /api/sandbox/run-code) ----

test('POST /api/sandbox/run-code runs inline code, writes the script, records a sandbox-code run, and is idempotent', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_carol', 'x-user-id': 'user_carol', 'idempotency-key': 'code-1' };
    const body = { tool: 'node', code: 'process.stdout.write("from-script:" + (2 + 3))', prompt: 'add two numbers' };
    const first = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(first.body.result.exitCode, 0);
    assert.equal(first.body.result.ok, true);
    assert.equal(first.body.result.stdout, 'from-script:5');
    assert.match(first.body.runId, /^run_/);
    assert.match(first.body.script, /^\.KimiCowork\/scripts\/run_[^/]+\.js$/);

    // the materialised script exists on disk inside the trusted root
    const scriptPath = path.join(trustedRoot, ...first.body.script.split('/'));
    assert.equal(fs.existsSync(scriptPath), true, 'script file should be written under the trusted root');

    // recorded + tenant-scoped as a sandbox-code run
    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_carol' } });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].type, 'sandbox-code');

    // idempotent replay
    const second = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotentReplay, true);
    assert.equal(second.body.runId, first.body.runId);
    const indexAfter = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_carol' } });
    assert.equal(indexAfter.body.runs.length, 1, 'replay must not create a second run');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/run-code records a failed run when the script exits non-zero', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'x-tenant-id': 'tenant_dan', 'idempotency-key': 'code-fail' };
    const body = { tool: 'node', code: 'process.stderr.write("boom"); process.exit(3)' };
    const res = await jsonRequest(base, '/api/sandbox/run-code', { method: 'POST', headers, body });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, false);
    assert.equal(res.body.result.exitCode, 3);
    assert.equal(res.body.result.stderr, 'boom');

    const index = await jsonRequest(base, '/api/runs/index', { headers: { 'x-tenant-id': 'tenant_dan' } });
    assert.equal(index.body.runs.length, 1);
    assert.equal(index.body.runs[0].status, 'failed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/run-code rejects a tool outside the allowlist with 400 and writes no script', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'code-bad' },
      body: { tool: 'ruby', code: 'puts 1' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not in the allowlist/);
    const scriptsDir = path.join(trustedRoot, '.KimiCowork', 'scripts');
    const wrote = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : [];
    assert.equal(wrote.length, 0, 'an invalid tool must not leave a script behind');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/run-code requires an Idempotency-Key', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      body: { tool: 'node', code: 'process.stdout.write("x")' },
    });
    assert.equal(res.status, 428);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/sandbox/run-code rejects an empty code body with 400', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/sandbox/run-code', {
      method: 'POST',
      headers: { 'idempotency-key': 'code-empty' },
      body: { tool: 'node', code: '   ' },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /code is required/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
