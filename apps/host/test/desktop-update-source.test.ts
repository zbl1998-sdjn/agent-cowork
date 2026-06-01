import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:http';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { readDesktopUpdateManifest } from '../src/runtime/desktop-update-source.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { closeTestServer } from './helpers/close-server.js';
import type { ServerConfig } from '../src/server.js';

function recordValue(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as Record<string, unknown>;
}

async function withServer(config: Partial<ServerConfig>, fn: (base: string) => Promise<void>) {
  const server = createServer({ requireAuth: false, enableScheduler: false, ...config });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { port } = address as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await closeTestServer(server);
  }
}

function writeManifest(root: string, body: Record<string, unknown>) {
  const file = path.join(root, 'latest.json');
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  return file;
}

test('desktop update source returns null when no signed newer manifest is configured', () => {
  assert.equal(readDesktopUpdateManifest({
    env: {},
    target: 'windows',
    arch: 'x86_64',
    currentVersion: '0.2.0',
  }), null);
});

test('desktop update source validates version, URL and platform signature', () => {
  const root = makeTestWorkspace('kcw-desktop-update-source');
  const manifestPath = writeManifest(root, {
    version: '0.3.0',
    pub_date: '2026-05-27T00:00:00.000Z',
    notes: 'P4-B updater smoke',
    platforms: {
      'windows-x86_64': {
        url: 'https://updates.example.test/Agent%20Cowork_0.3.0_x64-setup.nsis.zip',
        signature: 'signed-by-tauri',
      },
    },
  });

  const manifest = readDesktopUpdateManifest({
    env: { KCW_DESKTOP_UPDATE_MANIFEST: manifestPath },
    target: 'windows',
    arch: 'x86_64',
    currentVersion: '0.2.0',
  });

  assert.deepEqual(manifest, {
    version: '0.3.0',
    pub_date: '2026-05-27T00:00:00.000Z',
    url: 'https://updates.example.test/Agent%20Cowork_0.3.0_x64-setup.nsis.zip',
    signature: 'signed-by-tauri',
    notes: 'P4-B updater smoke',
  });
  assert.equal(readDesktopUpdateManifest({
    env: { KCW_DESKTOP_UPDATE_MANIFEST: manifestPath },
    target: 'windows',
    arch: 'x86_64',
    currentVersion: '0.3.0',
  }), null);
});

test('desktop update source route returns no-update or dynamic updater JSON', async () => {
  const root = makeTestWorkspace('kcw-desktop-update-route');
  const manifestPath = writeManifest(root, {
    version: '0.3.0',
    url: 'http://127.0.0.1:3017/downloads/update.zip',
    signature: 'loopback-signature',
  });

  await withServer({ trustedRoot: root, desktopUpdateEnv: {} }, async (base) => {
    const response = await fetch(`${base}/desktop-update/windows/x86_64/0.2.0`);
    assert.equal(response.status, 204);
  });

  await withServer({
    trustedRoot: root,
    desktopUpdateEnv: { KCW_DESKTOP_UPDATE_MANIFEST: manifestPath },
  }, async (base) => {
    const response = await fetch(`${base}/desktop-update/windows/x86_64/0.2.0`);
    assert.equal(response.status, 200);
    const body = recordValue(await response.json(), 'desktop update response');
    assert.equal(body.version, '0.3.0');
    assert.equal(body.url, 'http://127.0.0.1:3017/downloads/update.zip');
    assert.equal(body.signature, 'loopback-signature');
  });
});
