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
    // `authorization` MUST be advertised: every signed-in request carries a
    // Bearer token, so the browser preflights for it. If it's absent the webview
    // blocks all authenticated calls (login still works — it has no token), which
    // previously surfaced as a misleading "configure API" hint in chat.
    assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reflects CORS for the Tauri webview origin (Windows: http://tauri.localhost)', async () => {
  const server = createServer({ trustedRoot: tempRoot(), enableScheduler: false });
  const base = await bind(server);
  try {
    const origin = 'http://tauri.localhost';
    const res = await fetch(`${base}/health`, { headers: { origin } });
    assert.equal(res.headers.get('access-control-allow-origin'), origin, 'desktop webview origin must be allowed or it cannot log in');
    const pre = await fetch(`${base}/api/auth/guest`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    // The desktop webview sends `Authorization: Bearer` on every signed-in call;
    // the preflight for it must be allowed or the app logs in but can't chat.
    assert.match(pre.headers.get('access-control-allow-headers') || '', /authorization/i);
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
