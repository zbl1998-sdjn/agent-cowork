import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { createWslDockerRunner } from '../src/sandbox/wsl-docker-runner.js';
import { present, recordValue } from './helpers/host-http.js';
import { fakeSpawn } from './helpers/sandbox.js';
import type { CapturedSpawn } from './helpers/sandbox.js';

const PYTHON_IMAGE = `python@sha256:${'a'.repeat(64)}`;
const NODE_IMAGE = `ghcr.io/example/node@sha256:${'b'.repeat(64)}`;

test('createWslDockerRunner builds an isolated docker command line', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: PYTHON_IMAGE, spawn: fakeSpawn(captured, { stdout: 'done' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = await runner(null, spec, { trustedRoot: '/work/root' });
  const args = present(captured.args, 'captured docker args');
  assert.equal(captured.command, 'docker');
  assert.ok(args.includes('--network=none'), 'no-network by default');
  assert.ok(args.includes('--pull=never'), 'runner must never pull during execution');
  assert.ok(args.includes('--read-only'), 'root filesystem is read-only');
  assert.ok(args.includes('--cap-drop=ALL'), 'all Linux capabilities are dropped');
  assert.ok(args.includes('--security-opt=no-new-privileges=true'), 'privilege escalation is blocked');
  assert.match(args.find((arg) => arg.startsWith('--user=')) || '', /^--user=[1-9][0-9]*:[1-9][0-9]*$/, 'container runs as a numeric non-root user');
  assert.ok(args.includes('--pids-limit=128'), 'process count is bounded');
  assert.ok(args.includes('--memory=512m') && args.includes('--memory-swap=512m'), 'memory and swap are bounded');
  assert.ok(args.includes('--cpus=1'), 'CPU is bounded');
  assert.ok(args.includes('--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777'), 'temporary writes use a bounded tmpfs');
  assert.ok(args.includes('--volume') && args.includes('/work/root:/work:ro'), 'workspace is read-only by default');
  assert.deepEqual(args.slice(-4), [PYTHON_IMAGE, 'python3', '-c', 'print(1)']);
  assert.equal(result.networkIsolated, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'done');
  assert.equal(result.backend, 'vm:docker');
});

test('createWslDockerRunner honours network:true with bridge networking', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: NODE_IMAGE, spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', ''], timeoutMs: 1000, network: true });
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.ok(present(captured.args, 'captured docker args').includes('--network=bridge'));
  assert.equal(result.networkIsolated, false);
});

test('createWslDockerRunner grants a writable workspace only when explicitly requested', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: PYTHON_IMAGE, spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3', workspaceWrite: true }, { allowWorkspaceWrite: true });
  await runner(null, spec, { trustedRoot: '/work/root' });
  const args = present(captured.args, 'captured docker args');
  assert.ok(args.includes('/work/root:/work:rw'));
  assert.ok(!args.includes('/work/root:/work:ro'));
});

test('createWslDockerRunner passes only normalized allowlisted environment variables to docker', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'docker', image: PYTHON_IMAGE, spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec(
    { tool: 'python3', env: { LANG: 'C.UTF-8', TASK_MODE: 'audit' } },
    { allowEnv: ['LANG', 'TASK_MODE'] },
  );

  await runner(null, spec, { trustedRoot: '/work/root' });

  const args = present(captured.args, 'captured docker args');
  assert.deepEqual(
    args.filter((_arg, index) => args[index - 1] === '-e'),
    ['LANG=C.UTF-8', 'TASK_MODE=audit'],
  );
});

test('docker runner rejects mutable tags and option-like image references', async () => {
  const spec = normalizeSandboxSpec({ tool: 'python3' });
  for (const image of ['python:3.12-slim', 'python:latest', '--privileged', 'repo@sha256:not-a-digest']) {
    const runner = createWslDockerRunner({ backend: 'docker', image, spawn: fakeSpawn({}) });
    await assert.rejects(
      () => runner(null, spec, { trustedRoot: '/root' }),
      /immutable image digest/,
      image,
    );
  }
});

test('createWslDockerRunner rejects WSL host execution by default before spawning', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'wsl', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3' });
  await assert.rejects(
    () => runner(null, spec, { trustedRoot: '/root' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cannot enforce workspace or host isolation/);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 501);
      return true;
    },
  );
  assert.equal(captured.command, undefined);
});

test('createWslDockerRunner builds a wsl command and warns about network with explicit unrestricted capability', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'wsl', distro: 'Ubuntu', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec(
    { tool: 'python3', args: ['-c', 'pass'], timeoutMs: 1000, unrestrictedHostExecution: true },
    { allowUnrestrictedHostExecution: true },
  );
  const result = await runner(null, spec, { trustedRoot: '/root' });
  assert.equal(captured.command, 'wsl.exe');
  assert.deepEqual(captured.args, ['-d', 'Ubuntu', '--', 'python3', '-c', 'pass']);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((warning) => /network/.test(warning)));
  assert.ok(result.warnings.some((warning) => /not a read-only or OS-isolated sandbox/.test(warning)));
});

test('createWslDockerRunner builds the default-distro wsl command for an explicit network request', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'wsl', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec(
    { tool: 'python3', args: ['-V'], timeoutMs: 1000, network: true, unrestrictedHostExecution: true },
    { allowUnrestrictedHostExecution: true },
  );

  const result = await runner(null, spec, { trustedRoot: '/root' });

  assert.equal(captured.command, 'wsl.exe');
  assert.deepEqual(captured.args, ['--', 'python3', '-V']);
  assert.equal(result.networkIsolated, false);
  assert.deepEqual(result.warnings, [
    'unrestricted host execution is enabled; this process is not a read-only or OS-isolated sandbox',
  ]);
});

test('createWslDockerRunner rejects a missing trusted root before spawning', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'wsl', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });

  await assert.rejects(() => runner(null, spec), /trustedRoot is required/);
  assert.equal(captured.command, undefined);
});

test('createWslDockerRunner rejects unsupported backends with an explicit 501 error', async () => {
  const captured: CapturedSpawn = {};
  const runner = createWslDockerRunner({ backend: 'HyperV', spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });

  await assert.rejects(
    () => runner(null, spec, { trustedRoot: '/root' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unsupported vm backend "hyperv"/);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 501);
      return true;
    },
  );
  assert.equal(captured.command, undefined);
});

test('docker runner fails fast (501) when no image is configured', async () => {
  const runner = createWslDockerRunner({ backend: 'docker', spawn: fakeSpawn({}) });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => runner(null, spec, { trustedRoot: '/root' }), /requires an image/);
});

test('createSandbox provisions a docker VM sandbox when given an image + spawn', async () => {
  const captured: CapturedSpawn = {};
  const sandbox = createSandbox({ backend: 'docker', image: PYTHON_IMAGE, spawn: fakeSpawn(captured, { stdout: 'vm-ok' }) });
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 5000 });
  const result = recordValue(await sandbox.exec(spec, { trustedRoot: '/work/root' }), 'provisioned vm sandbox result');
  assert.equal(result.stdout, 'vm-ok');
  assert.equal(result.networkIsolated, true);
  assert.equal(captured.command, 'docker');
});
