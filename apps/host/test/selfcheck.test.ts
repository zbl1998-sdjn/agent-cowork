import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServerConfig } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import { makeTestWorkspace } from './test-fixtures.js';

type JsonRecord = Record<string, unknown>;

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

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function checkStatus(body: JsonRecord, id: string): unknown {
  assert.ok(Array.isArray(body.checks), 'checks must be an array');
  const check = body.checks.find((candidate) => isJsonRecord(candidate) && candidate.id === id);
  assert.ok(check, `check ${id} must exist`);
  return check.status;
}

test('GET /api/selfcheck reports posture and never exposes the API key', async () => {
  const trustedRoot = makeTestWorkspace('kcw-selfcheck');
  await withServer({ trustedRoot, modelApiKey: 'sk-SELFCHECKSECRET1234567890' }, async (base) => {
    const res = await fetch(`${base}/api/selfcheck`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes('sk-SELFCHECKSECRET'), 'self-check leaked the API key');
    const body = requireJsonRecord(JSON.parse(raw), 'selfcheck response');
    const security = requireJsonRecord(body.security, 'security');
    const apiKey = requireJsonRecord(security.apiKey, 'security.apiKey');
    assert.equal(apiKey.configured, true);
    assert.equal(apiKey.hasKey, true);
    assert.equal(apiKey.apiKey, undefined);
    assert.ok(
      Array.isArray(security.responseHeaders) && security.responseHeaders.includes('X-Content-Type-Options'),
    );
    const resilience = requireJsonRecord(body.resilience, 'resilience');
    const rateLimit = requireJsonRecord(resilience.rateLimit, 'resilience.rateLimit');
    assert.equal(rateLimit.enabled, true);
    assert.ok(Array.isArray(body.checks) && body.checks.length >= 6);
    assert.equal(checkStatus(body, 'api-key'), 'pass');
    assert.equal(checkStatus(body, 'rate-limit'), 'pass');
  });
});

test('self-check warns when no API key is configured', async () => {
  const trustedRoot = makeTestWorkspace('kcw-selfcheck-nokey');
  await withServer({ trustedRoot }, async (base) => {
    const body = requireJsonRecord(await (await fetch(`${base}/api/selfcheck`)).json(), 'selfcheck response');
    const security = requireJsonRecord(body.security, 'security');
    assert.equal(requireJsonRecord(security.apiKey, 'security.apiKey').configured, false);
    assert.equal(checkStatus(body, 'api-key'), 'warn');
  });
});
