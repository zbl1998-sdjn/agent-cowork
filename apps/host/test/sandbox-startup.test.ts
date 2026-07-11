import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSandboxStartup } from '../src/sandbox/startup-probe.js';
import type { SpawnSyncLike } from '../src/sandbox/startup-probe.js';
import { objectField } from './helpers/host-http.js';
import { fakeProbeSpawnSync } from './helpers/sandbox.js';

const immutableImage = `python@sha256:${'a'.repeat(64)}`;

test('resolveSandboxStartup selects docker by default when daemon and local image are available', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: { image: immutableImage },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      [`docker image inspect ${immutableImage}`]: { stdout: '[]\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'docker');
  assert.equal(startup.options.image, immutableImage);
  assert.equal(startup.info.selectedBackend, 'docker');
  assert.equal(startup.info.networkIsolated, true);
  assert.equal(startup.info.fallback, false);
  const backends = objectField(startup.info, 'backends', 'startup backends');
  const docker = objectField(backends, 'docker', 'docker backend probe');
  assert.equal(docker.usable, true);
  assert.equal(docker.imagePresent, true);
});

test('resolveSandboxStartup rejects a mutable Docker tag even when it is present locally', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: { image: 'python:3.12-slim' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'docker image inspect python:3.12-slim': { stdout: '[]\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.fallback, true);
  assert.match(startup.info.fallbackReason || '', /immutable|sha256/i);
  const backends = objectField(startup.info, 'backends', 'startup backends');
  const docker = objectField(backends, 'docker', 'docker backend probe');
  assert.equal(docker.available, true);
  assert.equal(docker.imagePresent, false);
  assert.equal(docker.usable, false);
});

test('resolveSandboxStartup policy-blocks an explicitly requested Docker backend with a mutable image', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'docker',
    sandboxOptions: { image: 'python:3.12-slim' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'docker');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.policyBlocked, true);
  assert.match(startup.info.userMessage, /blocked|immutable|sha256/i);
});

test('resolveSandboxStartup falls back to local when no true isolated backend is usable', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: { image: immutableImage },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      [`docker image inspect ${immutableImage}`]: { status: 1, stderr: 'No such image' },
      'wsl.exe --status': { stdout: 'Default Version: 2\n' },
    }),
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.selectedBackend, 'local');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.fallback, true);
  assert.match(String(startup.info.userMessage), /本地不隔离网络/);
  const backends = objectField(startup.info, 'backends', 'startup backends');
  const docker = objectField(backends, 'docker', 'docker backend probe');
  const wsl = objectField(backends, 'wsl', 'wsl backend probe');
  assert.equal(docker.available, true);
  assert.equal(docker.usable, false);
  assert.equal(wsl.available, true);
  assert.equal(wsl.networkIsolated, false);
});

test('resolveSandboxStartup marks local strict high-risk execution as policy blocked instead of safe fallback', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    env: { SECURITY_MODE: 'local_strict', KCW_SANDBOX_DOCKER_IMAGE: immutableImage },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      [`docker image inspect ${immutableImage}`]: { status: 1, stderr: 'No such image' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.securityMode, 'local_strict');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.policyBlocked, true);
  assert.match(startup.info.userMessage, /high-risk execution tools are blocked/);
});

test('resolveSandboxStartup marks explicit non-isolated local strict sandbox as policy blocked', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'local',
    env: { SECURITY_MODE: 'local_strict' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'daemon down' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.securityMode, 'local_strict');
  assert.equal(startup.info.policyBlocked, true);
  assert.match(startup.info.userMessage, /explicit non-isolated sandbox/);
});

test('resolveSandboxStartup also marks air_gap high-risk execution as policy blocked (dogfood regression: this used to only check local_strict, silently missing the stricter air_gap mode)', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    env: { SECURITY_MODE: 'air_gap' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'daemon down' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.securityMode, 'air_gap');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.policyBlocked, true);
  assert.match(startup.info.userMessage, /high-risk execution tools are blocked/);
});

test('resolveSandboxStartup marks explicit non-isolated air_gap sandbox as policy blocked', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'local',
    env: { SECURITY_MODE: 'air_gap' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'daemon down' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.info.securityMode, 'air_gap');
  assert.equal(startup.info.policyBlocked, true);
  assert.match(startup.info.userMessage, /explicit non-isolated sandbox/);
});

test('resolveSandboxStartup keeps probe failures and explicit backend isolation claims honest', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawnSync: SpawnSyncLike = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'docker') {
      return { status: 1, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'docker missing' } };
    }
    throw new Error('wsl probe exploded');
  };

  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: {},
    env: {},
    spawnSync,
    timeoutMs: 25,
  });

  assert.equal(startup.options.backend, 'local');
  assert.equal(startup.info.networkIsolated, false);
  assert.equal(startup.info.fallback, true);
  assert.match(startup.info.fallbackReason || '', /No Docker backend/);
  assert.equal(calls[0]?.command, 'docker');
  assert.deepEqual(calls[0]?.args, ['info', '--format', '{{.ServerVersion}}']);
  assert.equal(calls[0]?.options.timeout, 25);
  assert.equal(calls[0]?.options.windowsHide, true);
  const backends = objectField(startup.info, 'backends', 'startup backends');
  const docker = objectField(backends, 'docker', 'docker backend probe');
  const wsl = objectField(backends, 'wsl', 'wsl backend probe');
  assert.equal(docker.reason, 'ENOENT');
  assert.equal(wsl.reason, 'wsl probe exploded');

  const missingImage = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: {},
    env: {},
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });
  assert.equal(missingImage.options.backend, 'local');
  assert.match(missingImage.info.fallbackReason || '', /KCW_SANDBOX_DOCKER_IMAGE is not configured/);

  const envImage = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: {},
    env: { KCW_SANDBOX_IMAGE: immutableImage },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      [`docker image inspect ${immutableImage}`]: { status: 1, stderr: 'No such image' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });
  assert.equal(envImage.options.image, immutableImage);
  assert.match(envImage.info.fallbackReason || '', /image .* is not present locally/);

  const explicitWsl = resolveSandboxStartup({
    requestedBackend: 'wsl',
    sandboxOptions: { distro: 'Ubuntu' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'daemon down' },
      'wsl.exe --status': { stdout: 'Default Version: 2\n' },
    }),
  });
  assert.equal(explicitWsl.options.backend, 'wsl');
  assert.equal(explicitWsl.info.networkIsolated, false);
  assert.equal(explicitWsl.info.userMessage, '本地不隔离网络: local sandbox runs on the host and cannot enforce network isolation.');

  const explicitVm = resolveSandboxStartup({
    requestedBackend: 'vm',
    sandboxOptions: {},
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'daemon down' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });
  assert.equal(explicitVm.options.backend, 'vm');
  assert.equal(explicitVm.info.networkIsolated, true);
  assert.equal(explicitVm.info.userMessage, 'explicit VM sandbox backend requested');
});
