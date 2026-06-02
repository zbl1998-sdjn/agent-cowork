import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerConfig } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { makeTestWorkspace } from './test-fixtures.js';

type JsonRecord = Record<string, unknown>;

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

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

test('connect rejects a client-supplied command (no arbitrary program execution)', async () => {
  const trustedRoot = makeTestWorkspace('kcw-connector');
  await withServer({ trustedRoot, requireAuth: false }, async (base) => {
    const res = await fetch(`${base}/api/connectors/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'evil', command: 'calc.exe', args: [] }),
    });
    assert.equal(res.status, 400);
    const errorBody = requireJsonRecord(await res.json(), 'error response');
    assert.match(requireString(errorBody.error, 'error'), /not allowed|unsupported/i);

    const malformed = await fetch(`${base}/api/connectors/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: ['filesystem'], command: 'calc.exe', args: [] }),
    });
    assert.equal(malformed.status, 400);
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
