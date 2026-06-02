import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { createWslDockerRunner } from '../src/sandbox/wsl-docker-runner.js';
import { present, recordValue } from './helpers/host-http.js';
import { fakeSpawn } from './helpers/sandbox.js';
import type { CapturedSpawn } from './helpers/sandbox.js';

test('createWslDockerRunner builds an isolated docker command line', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: 'python:3.12-slim', spawn: fakeSpawn(captured, { stdout: 'done' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = await runner(null, spec, { trustedRoot: '/work/root' });
  const args = present(captured.args, 'captured docker args');
  assert.equal(captured.command, 'docker');
  assert.ok(args.includes('--network=none'), 'no-network by default');
  assert.ok(args.includes('-v') && args.includes('/work/root:/work'), 'workspace mounted');
  assert.deepEqual(args.slice(-4), ['python:3.12-slim', 'python3', '-c', 'print(1)']);
  assert.equal(result.networkIsolated, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
  assert.equal(result.backend, 'vm:docker');
});

test('createWslDockerRunner honours network:true with bridge networking', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: 'node:20', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', ''], timeoutMs: 1000, network: true });
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.ok(present(captured.args, 'captured docker args').includes('--network=bridge'));
  assert.equal(result.networkIsolated, false);
});

test('createWslDockerRunner builds a wsl command and warns about network', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'wsl', distro: 'Ubuntu', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'pass'], timeoutMs: 1000 });
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.equal(captured.command, 'wsl.exe');
  assert.deepEqual(captured.args, ['-d', 'Ubuntu', '--', 'python3', '-c', 'pass']);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((warning) => /network/.test(warning)));
});

test('docker runner fails fast (501) when no image is configured', async () => {
  const runner = createWslDockerRunner({ backend: 'docker', spawn: fakeSpawn({}) });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => runner(null, spec, { trustedRoot: '/root' }), /requires an image/);
});

test('createSandbox provisions a docker VM sandbox when given an image + spawn', async () => {
  const captured: CapturedSpawn = {};
  const sandbox = createSandbox({ backend: 'docker', image: 'python:3.12-slim', spawn: fakeSpawn(captured, { stdout: 'vm-ok' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = recordValue(await sandbox.exec(spec, { trustedRoot: '/work/root' }), 'provisioned vm sandbox result');
  assert.equal(result.stdout, 'vm-ok');
  assert.equal(result.networkIsolated, true);
  assert.equal(captured.command, 'docker');
});
