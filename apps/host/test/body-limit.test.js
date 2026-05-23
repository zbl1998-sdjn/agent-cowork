import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../src/http/request-utils.js';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('readJsonBody rejects an oversized body with 413 and drains (no early destroy)', async () => {
  const req = new EventEmitter();
  let destroyed = false; let resumed = false;
  req.pause = () => {};
  req.resume = () => { resumed = true; };
  req.destroy = () => { destroyed = true; };
  const p = readJsonBody(req, { maxBytes: 10 });
  req.emit('data', Buffer.from('x'.repeat(64)));
  await assert.rejects(p, (e) => e.statusCode === 413);
  assert.ok(!destroyed, 'must not destroy before the 413 response is sent');
  assert.ok(resumed, 'should drain the remaining body');
});

test('readJsonBody resolves a normal body', async () => {
  const req = new EventEmitter();
  const p = readJsonBody(req, { maxBytes: 1024 });
  req.emit('data', Buffer.from(JSON.stringify({ ok: true })));
  req.emit('end');
  assert.deepEqual(await p, { ok: true });
});

async function withServer(config, fn) {
  const server = createServer(config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('POST with an oversized JSON body returns a clean 413', async () => {
  const trustedRoot = makeTestWorkspace('kcw-bodylimit');
  await withServer({ trustedRoot, rateLimit: false, requireAuth: false }, async (base) => {
    const body = JSON.stringify({ path: 'a', blob: 'x'.repeat(1.2 * 1024 * 1024) }); // > 1MB default
    let status = 0;
    try {
      const res = await fetch(`${base}/api/files/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      status = res.status;
    } catch (e) { status = `threw:${e.message}`; }
    assert.equal(status, 413, 'client should receive a 413, not a connection reset');
  });
});
