import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('GET /metrics is exempt from the auth gate and exposes only operational gauges', async () => {
  const trustedRoot = makeTestWorkspace('kcw-metrics');
  // requireAuth defaults ON; /metrics must still be reachable (like /health).
  const server = createServer({ trustedRoot });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200, '/metrics should be reachable without a token');
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const text = await res.text();
    assert.match(text, /kcw_uptime_seconds \d+/);
    assert.match(text, /kcw_concurrency_active \d+/);
    assert.match(text, /kcw_model_breakers_open \d+/);
    assert.match(text, /process_resident_memory_bytes \d+/);
    // hardening headers still applied.
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
