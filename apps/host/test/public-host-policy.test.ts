import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  PUBLIC_HOST_SECURITY,
  resolvePublicHost,
  withPublicHostSecurity,
} from '../src/security/public-host-policy.js';

test('public host policy rejects non-loopback bindings', () => {
  assert.equal(resolvePublicHost(undefined), '127.0.0.1');
  assert.equal(resolvePublicHost('localhost'), 'localhost');
  assert.equal(resolvePublicHost('127.0.0.1'), '127.0.0.1');
  assert.equal(resolvePublicHost('::1'), '::1');
  assert.equal(resolvePublicHost('[::1]'), '::1');

  for (const host of ['0.0.0.0', '192.168.1.10', 'host.internal', '']) {
    assert.throws(
      () => resolvePublicHost(host),
      /refusing non-loopback HOST/,
      host,
    );
  }
});

test('public host policy forces fail-closed server flags', () => {
  assert.deepEqual(PUBLIC_HOST_SECURITY, {
    requireAuth: true,
    validateHost: true,
    trustIdentityHeaders: false,
  });
  assert.equal(Object.isFrozen(PUBLIC_HOST_SECURITY), true);

  const insecureConfig = {
    trustedRoot: 'C:\\workspace',
    requireAuth: false,
    validateHost: false,
    trustIdentityHeaders: true,
  };
  assert.deepEqual(withPublicHostSecurity(insecureConfig), {
    trustedRoot: 'C:\\workspace',
    requireAuth: true,
    validateHost: true,
    trustIdentityHeaders: false,
  });
  assert.deepEqual(insecureConfig, {
    trustedRoot: 'C:\\workspace',
    requireAuth: false,
    validateHost: false,
    trustIdentityHeaders: true,
  });
});

test('every public host entrypoint uses the shared fail-closed policy', () => {
  const repoRoot = fs.existsSync(path.join(process.cwd(), 'apps', 'host'))
    ? process.cwd()
    : path.resolve(process.cwd(), '..', '..');
  const entrypoints = [
    'apps/host/src/main.ts',
    'scripts/start-mvp.ts',
    'scripts/start-tauri-host.ts',
  ];

  for (const relativePath of entrypoints) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    assert.match(source, /public-host-policy\.js/, relativePath);
    assert.match(source, /resolvePublicHost\(/, relativePath);
    assert.match(
      source,
      /createServer\(\s*withPublicHostSecurity\(/,
      relativePath,
    );
  }
});
