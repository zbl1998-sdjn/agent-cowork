import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:http';
import { createServer } from '../src/server.js';
import type { HostServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';
import { closeTestServer } from './helpers/close-server.js';

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

test('GET /metrics is disabled by default (secure by default)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-metrics-off');
  delete process.env.KCW_METRICS_ENABLED;
  const server = createServer({ trustedRoot });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 404, '/metrics must be off unless explicitly enabled');
  } finally {
    await closeTestServer(server);
  }
});

test('GET /metrics, when enabled, is exempt from the auth gate and exposes only operational gauges', async () => {
  const trustedRoot = makeTestWorkspace('kcw-metrics');
  process.env.KCW_METRICS_ENABLED = 'true';
  try {
    // requireAuth defaults ON; an explicitly-enabled /metrics must still be reachable (like /health).
    const server = createServer({ trustedRoot });
    const base = await bind(server);
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 200, 'enabled /metrics should be reachable without a token');
      assert.match(res.headers.get('content-type') || '', /text\/plain/);
      const text = await res.text();
      assert.match(text, /kcw_uptime_seconds \d+/);
      assert.match(text, /kcw_concurrency_active \d+/);
      assert.match(text, /kcw_model_breakers_open \d+/);
      assert.match(text, /process_resident_memory_bytes \d+/);
      // hardening headers still applied.
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await closeTestServer(server);
    }
  } finally {
    delete process.env.KCW_METRICS_ENABLED;
  }
});
