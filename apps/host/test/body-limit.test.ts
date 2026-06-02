import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerConfig } from '../src/server.js';
import { readJsonBody } from '../src/http/request-utils.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { ManualHttpRequest } from './helpers/manual-http-request.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('readJsonBody rejects an oversized body with 413 and drains (no early destroy)', async () => {
  const req = new ManualHttpRequest();
  const p = readJsonBody(req, { maxBytes: 10 });
  req.emit('data', Buffer.from('x'.repeat(64)));
  await assert.rejects(() => p, (error) => isStatusCode(error, 413));
  assert.ok(!req.destroyed, 'must not destroy before the 413 response is sent');
  assert.ok(req.resumed, 'should drain the remaining body');
});

test('readJsonBody resolves a normal body', async () => {
  const req = new ManualHttpRequest();
  const p = readJsonBody(req, { maxBytes: 1024 });
  req.emit('data', Buffer.from(JSON.stringify({ ok: true })));
  req.emit('end');
  assert.deepEqual(await p, { ok: true });
});

function isStatusCode(error: unknown, statusCode: number): boolean {
  return Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === statusCode);
}

async function withServer(config: ServerConfig, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(config);
  await new Promise<void>((resolve, reject) => {
    server.on('error', (error) => reject(error));
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeTestServer(server);
  }
}

test('POST with an oversized JSON body returns a clean 413', async () => {
  const trustedRoot = makeTestWorkspace('kcw-bodylimit');
  await withServer({ trustedRoot, rateLimit: false, requireAuth: false }, async (base) => {
    const body = JSON.stringify({ path: 'a', blob: 'x'.repeat(1.2 * 1024 * 1024) }); // > 1MB default
    let status: number | string = 0;
    try {
      const res = await fetch(`${base}/api/files/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      status = res.status;
    } catch (error) {
      status = `threw:${error instanceof Error ? error.message : String(error)}`;
    }
    assert.equal(status, 413, 'client should receive a 413, not a connection reset');
  });
});
