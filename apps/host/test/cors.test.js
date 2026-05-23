import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cors-'));
}
async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('host reflects CORS headers for a loopback origin (browser preview at :5173)', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const origin = 'http://127.0.0.1:5173';
    const res = await fetch(`${base}/health`, { headers: { origin } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('vary'), 'Origin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OPTIONS preflight from a loopback origin returns 204 with allow headers', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const origin = 'http://localhost:5173';
    const res = await fetch(`${base}/api/tools/call`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(res.headers.get('access-control-allow-headers') || '', /idempotency-key/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a non-loopback origin is not reflected and its preflight is rejected', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const origin = 'http://evil.example.com';
    const res = await fetch(`${base}/health`, { headers: { origin } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${base}/api/tools/call`, { method: 'OPTIONS', headers: { origin } });
    assert.equal(pre.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
