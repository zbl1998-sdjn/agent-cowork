import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HostServer } from '../src/server.js';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

type JsonRecord = Record<string, unknown>;
type RunsListArgs = { tenantId?: string };
type AsyncRunSummary = { id: string; tenantId: string; type: string; status: string };
type AsyncRunsIndex = {
  list(args: RunsListArgs): Promise<AsyncRunSummary[]>;
  stats(): Promise<{ total: number; byStatus: Record<string, number>; byType: Record<string, number> }>;
  get(): Promise<null>;
  upsert(record: unknown): Promise<unknown>;
  remove(): Promise<boolean>;
  size(): Promise<number>;
};

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-async-'));
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

// Proves the run-routes read path awaits the index, so the async PostgreSQL
// adapter (and any Promise-returning repository) works through HTTP.
test('E2E: /api/runs/index works with an async (Postgres-style) runsIndex', async () => {
  const root = tmp();
  const listArgs: { current: RunsListArgs | null } = { current: null };
  const asyncIndex: AsyncRunsIndex = {
    async list(args) {
      listArgs.current = args;
      return [{ id: 'run_x', tenantId: 'tenant_local', type: 'agent-chat', status: 'succeeded' }];
    },
    async stats() {
      return { total: 1, byStatus: { succeeded: 1 }, byType: { 'agent-chat': 1 } };
    },
    async get() {
      return null;
    },
    async upsert(record) {
      return record;
    },
    async remove() {
      return false;
    },
    async size() {
      return 1;
    },
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, runsIndex: asyncIndex });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/runs/index?limit=10`);
    assert.equal(res.status, 200);
    const body = requireJsonRecord(await res.json(), 'runs index response');
    assert.ok(
      Array.isArray(body.runs) && body.runs.some((run) => isJsonRecord(run) && run.id === 'run_x'),
      'async list surfaced through HTTP (not a Promise)',
    );
    assert.equal(requireJsonRecord(body.stats, 'runs index stats').total, 1);
    assert.equal(listArgs.current?.tenantId, 'tenant_local', 'tenant scoping passed to the async adapter');
  } finally {
    await closeTestServer(server);
  }
});
