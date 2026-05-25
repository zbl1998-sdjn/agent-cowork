import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer({ requireAuth: false, enableScheduler: false, ...config });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/runtime/dependencies reports runtime catalog without leaking proxy credentials', async () => {
  const trustedRoot = makeTestWorkspace('kcw-runtime-deps');
  await withServer({
    trustedRoot,
    runtimeDependencyEnv: {
      HTTPS_PROXY: 'http://proxy-user:proxy-password@127.0.0.1:7890',
      KCW_EMBEDDED_PYTHON: 'C:\\AgentCowork\\runtime\\python\\python.exe',
      KCW_WEBVIEW2_MODE: 'evergreen',
    },
  }, async (base) => {
    const response = await fetch(`${base}/api/runtime/dependencies`);
    assert.equal(response.status, 200);

    const raw = await response.text();
    assert.ok(!raw.includes('proxy-password'), 'runtime dependency status leaked proxy password');
    const body = JSON.parse(raw);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'agent-cowork-host');
    assert.equal(body.platform, process.platform);
    assert.ok(Array.isArray(body.dependencies));
    assert.ok(body.dependencies.length >= 6);
    assert.ok(body.summary.total >= body.dependencies.length);

    const byId = Object.fromEntries(body.dependencies.map((item) => [item.id, item]));
    assert.equal(byId.node.status, 'available');
    assert.match(byId.node.version, /^v\d+\./);
    assert.equal(byId.node.required, true);
    assert.equal(byId.webview2.installMode, 'system');
    assert.equal(byId['python-embedded'].status, 'configured');
    assert.equal(byId.proxy.status, 'configured');
    assert.equal(byId.proxy.detail, 'http://proxy-user:[REDACTED]@127.0.0.1:7890');
  });
});
