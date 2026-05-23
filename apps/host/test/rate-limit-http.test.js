import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, ...config });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('429 + Retry-After when a tenant exceeds its rate limit; /health is exempt', async () => {
  const trustedRoot = makeTestWorkspace('kcw-ratelimit');
  await withServer({ trustedRoot, rateLimitPerSec: 1, rateLimitBurst: 2 }, async (base) => {
    const a = await fetch(`${base}/api/workspace`);
    const b = await fetch(`${base}/api/workspace`);
    const c = await fetch(`${base}/api/workspace`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429, 'third request should be rate limited');
    assert.ok(c.headers.get('retry-after'), 'Retry-After header present');
    assert.equal(c.headers.get('x-ratelimit-limit'), '2');
    assert.equal(c.headers.get('x-ratelimit-remaining'), '0');

    // /health is never throttled.
    const h = await fetch(`${base}/health`);
    assert.equal(h.status, 200);
  });
});

test('rate limiting can be disabled with rateLimit:false', async () => {
  const trustedRoot = makeTestWorkspace('kcw-ratelimit-off');
  await withServer({ trustedRoot, rateLimit: false }, async (base) => {
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${base}/api/workspace`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('x-ratelimit-limit'), null, 'no rate-limit headers when disabled');
    }
  });
});
