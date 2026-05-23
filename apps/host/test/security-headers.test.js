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

const EXPECTED = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

test('hardening headers are present on every response', async () => {
  const trustedRoot = makeTestWorkspace('kcw-sechdr');
  await withServer({ trustedRoot }, async (baseUrl) => {
    for (const route of ['/health', '/api/workspace']) {
      const res = await fetch(`${baseUrl}${route}`);
      for (const [name, value] of Object.entries(EXPECTED)) {
        assert.equal(res.headers.get(name), value, `${route} -> ${name}`);
      }
    }
  });
});

test('hostile cross-origin is not reflected in ACAO', async () => {
  const trustedRoot = makeTestWorkspace('kcw-cors-hostile');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/workspace`, { headers: { origin: 'https://evil.example' } });
    const acao = res.headers.get('access-control-allow-origin');
    assert.ok(!acao || !/evil\.example/.test(acao), `ACAO must not reflect hostile origin (got ${acao})`);
  });
});
