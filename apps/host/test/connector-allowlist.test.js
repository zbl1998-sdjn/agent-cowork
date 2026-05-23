import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer(config);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try { await fn(`http://127.0.0.1:${port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('connect rejects a client-supplied command (no arbitrary program execution)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-connector');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    const res = await fetch(`${base}/api/connectors/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'evil', command: 'calc.exe', args: [] }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not allowed|unsupported/i);
  });
});

test('connect rejects an install-only / unknown connector id', async () => {
  const trustedRoot = makeTestWorkspace('kcw-connector-2');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    for (const id of ['sqlite', 'git', 'totally-unknown']) {
      const res = await fetch(`${base}/api/connectors/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, command: 'npx -y something' }),
      });
      assert.equal(res.status, 400, `id=${id} should be rejected`);
    }
  });
});
