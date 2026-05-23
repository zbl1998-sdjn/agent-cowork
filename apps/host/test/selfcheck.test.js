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

test('GET /api/selfcheck reports posture and never exposes the API key', async () => {
  const trustedRoot = makeTestWorkspace('kcw-selfcheck');
  await withServer({ trustedRoot, kimiApiKey: 'sk-SELFCHECKSECRET1234567890' }, async (base) => {
    const res = await fetch(`${base}/api/selfcheck`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes('sk-SELFCHECKSECRET'), 'self-check leaked the API key');
    const j = JSON.parse(raw);
    assert.equal(j.security.apiKey.configured, true);
    assert.equal(j.security.apiKey.hasKey, true);
    assert.equal(j.security.apiKey.apiKey, undefined);
    assert.ok(Array.isArray(j.security.responseHeaders) && j.security.responseHeaders.includes('X-Content-Type-Options'));
    assert.equal(j.resilience.rateLimit.enabled, true);
    assert.ok(Array.isArray(j.checks) && j.checks.length >= 6);
    assert.equal(j.checks.find((c) => c.id === 'api-key').status, 'pass');
    assert.equal(j.checks.find((c) => c.id === 'rate-limit').status, 'pass');
  });
});

test('self-check warns when no API key is configured', async () => {
  const trustedRoot = makeTestWorkspace('kcw-selfcheck-nokey');
  await withServer({ trustedRoot }, async (base) => {
    const j = await (await fetch(`${base}/api/selfcheck`)).json();
    assert.equal(j.security.apiKey.configured, false);
    assert.equal(j.checks.find((c) => c.id === 'api-key').status, 'warn');
  });
});
