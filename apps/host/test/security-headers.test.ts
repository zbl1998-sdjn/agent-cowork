import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import type { ServerConfig } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config: ServerConfig, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer({ requireAuth: false, ...config });
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
