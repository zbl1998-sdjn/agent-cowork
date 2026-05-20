import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function withServer(config, fn) {
  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health returns stable host metadata', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-trusted-'));
  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'kimi-cowork-host',
    });
  });
});

test('file tree rejects roots outside configured trusted root', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-trusted-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-outside-'));
  fs.writeFileSync(path.join(outsideRoot, 'leak.txt'), 'secret');

  await withServer({ trustedRoot }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/files/tree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: outsideRoot }),
    });
    assert.notEqual(response.status, 200);
    const body = await response.json();
    assert.match(body.error, /trusted root/i);
  });
});
