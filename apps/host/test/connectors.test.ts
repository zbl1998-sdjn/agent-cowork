import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listConnectors, suggestConnectors } from '../src/connectors/catalog.js';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

type JsonRecord = Record<string, unknown>;
type ConnectorSummary = { id: string };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-conn-'));
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireJsonRecord(value: unknown, label: string): JsonRecord {
  if (!isJsonRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  return value;
}

function connectorSummaries(value: unknown): ConnectorSummary[] {
  assert.ok(Array.isArray(value), 'connectors must be an array');
  return value.map((candidate) => {
    const connector = requireJsonRecord(candidate, 'connector');
    const { id } = connector;
    if (typeof id !== 'string') throw new TypeError('connector.id must be a string');
    return { id };
  });
}

async function readJson(base: string, route: string): Promise<{ status: number; body: JsonRecord | null }> {
  const res = await fetch(`${base}${route}`);
  const text = await res.text();
  return { status: res.status, body: text ? requireJsonRecord(JSON.parse(text), 'response body') : null };
}

test('connector catalog lists and keyword-suggests', () => {
  assert.ok(listConnectors().length >= 5);
  const sqlite = suggestConnectors('数据库 sql');
  assert.ok(sqlite.some((c) => c.id === 'sqlite' || c.id === 'postgres'));
  const web = suggestConnectors('抓取网页');
  assert.ok(web.some((c) => c.id === 'web-fetch'));
  assert.ok(suggestConnectors('').length >= 1);
});

test('GET /api/connectors + /api/connectors/suggest', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const all = await readJson(base, '/api/connectors');
    assert.equal(all.status, 200);
    const allBody = requireJsonRecord(all.body, 'connectors response');
    assert.ok(connectorSummaries(allBody.connectors).length >= 5);

    const sug = await readJson(base, '/api/connectors/suggest?q=git');
    const suggestBody = requireJsonRecord(sug.body, 'suggest response');
    assert.equal(suggestBody.query, 'git');
    assert.ok(connectorSummaries(suggestBody.connectors).some((connector) => connector.id === 'git'));
  } finally {
    await closeTestServer(server);
  }
});
