import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:http';
import test from 'node:test';

import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { makeTestWorkspace } from './test-fixtures.js';

const SECRET_ENV = 'KCW_SIDECAR_SECRET';
const SECRET = '00'.repeat(32);
const CHALLENGE = '11'.repeat(32);
const EXPECTED_PROOF = '520d4536568f6fd6b8d6841c9d991bdefe9432d0e3e70ee4922b192ccb50874b';

test('health exposes sidecar proof only for a valid native challenge and launch secret', async () => {
  const previousSecret = process.env[SECRET_ENV];
  Reflect.deleteProperty(process.env, SECRET_ENV);

  const server = createServer({
    trustedRoot: makeTestWorkspace('kcw-sidecar-proof'),
    enableScheduler: false,
    requireAuth: true,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${(address as AddressInfo).port}`;

  try {
    const ordinary = await fetch(`${base}/health`);
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.headers.get('x-kcw-sidecar-proof'), null);
    assert.deepEqual(await ordinary.json(), { ok: true, service: 'agent-cowork-host' });

    const unavailable = await fetch(`${base}/health`, {
      headers: { 'x-kcw-sidecar-challenge': CHALLENGE },
    });
    assert.equal(unavailable.status, 404);
    assert.equal(unavailable.headers.get('x-kcw-sidecar-proof'), null);
    assert.equal(await unavailable.text(), '');

    process.env[SECRET_ENV] = SECRET;
    const malformed = await fetch(`${base}/health`, {
      headers: { 'x-kcw-sidecar-challenge': 'not-a-valid-challenge' },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('x-kcw-sidecar-proof'), null);

    const verified = await fetch(`${base}/health`, {
      headers: { 'x-kcw-sidecar-challenge': CHALLENGE },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.headers.get('cache-control'), 'no-store');
    assert.equal(verified.headers.get('x-kcw-sidecar-proof'), EXPECTED_PROOF);
    assert.equal(await verified.text(), '');
  } finally {
    await closeTestServer(server);
    if (previousSecret === undefined) Reflect.deleteProperty(process.env, SECRET_ENV);
    else process.env[SECRET_ENV] = previousSecret;
  }
});
