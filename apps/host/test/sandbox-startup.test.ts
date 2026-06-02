import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSandboxStartup } from '../src/sandbox/startup-probe.js';
import { objectField } from './helpers/host-http.js';
import { fakeProbeSpawnSync } from './helpers/sandbox.js';

test('resolveSandboxStartup selects docker by default when daemon and local image are available', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: { image: 'python:3.12-slim' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'docker image inspect python:3.12-slim': { stdout: '[]\n' },
      'wsl.exe --status': { status: 1, stderr: 'not installed' },
    }),
  });

  assert.equal(startup.options.backend, 'docker');
  assert.equal(startup.options.image, 'python:3.12-slim');
  assert.equal(startup.info.selectedBackend, 'docker');
  assert.equal(startup.info.networkIsolated, true);
  assert.equal(startup.info.fallback, false);
  const backends = objectField(startup.info, 'backends', 'startup backends');
  const docker = objectField(backends, 'docker', 'docker backend probe');
  assert.equal(docker.usable, true);
  assert.equal(docker.imagePresent, true);
});

test('resolveSandboxStartup falls back to local when no true isolated backend is usable', () => {
  const startup = resolveSandboxStartup({
    requestedBackend: 'auto',
    sandboxOptions: { image: 'python:3.12-slim' },
    spawnSync: fakeProbeSpawnSync({
      'docker info --format {{.ServerVersion}}': { stdout: '26.1.0\n' },
      'docker image inspect python:3.12-slim': { status: 1, stderr: 'No such image' },
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
