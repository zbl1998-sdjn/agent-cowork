import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-uidist-'));
}
function seedUiDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-react-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>REACT_UI_ROOT</body></html>', 'utf8');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log("hi");', 'utf8');
  return dir;
}
async function bind(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function get(base, route) {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.text() };
}

test('host serves the React SPA from ui-dist when it exists', async () => {
  const uiDistRoot = seedUiDist();
  const server = createServer({ trustedRoot: tmp(), uiDistRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const root = await get(base, '/');
    assert.ok(root.type.includes('text/html'));
    assert.match(root.body, /REACT_UI_ROOT/);

    const asset = await get(base, '/assets/app.js');
    assert.equal(asset.status, 200);
    assert.ok(asset.type.includes('javascript'));
    assert.match(asset.body, /console\.log/);

    // SPA fallback: a client route with no extension serves index.html
    const route = await get(base, '/tools/search');
    assert.match(route.body, /REACT_UI_ROOT/);

    // a missing asset (has extension) is not faked as index.html
    const missing = await get(base, '/assets/missing.js');
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('SPA serving never hijacks /api or /health', async () => {
  const uiDistRoot = seedUiDist();
  const server = createServer({ trustedRoot: tmp(), uiDistRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const tools = await get(base, '/api/tools');
    assert.equal(tools.status, 200);
    assert.ok(tools.type.includes('application/json'));
    assert.match(tools.body, /"tools"/);

    const health = await get(base, '/health');
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":true/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('falls back to the legacy static UI when ui-dist is disabled', async () => {
  const server = createServer({ trustedRoot: tmp(), uiDist: false, enableScheduler: false });
  const base = await bind(server);
  try {
    const root = await get(base, '/');
    // legacy resources/index.html still carries the old mode-switch markup
    assert.ok(root.type.includes('text/html'));
    assert.match(root.body, /Agent Cowork/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
