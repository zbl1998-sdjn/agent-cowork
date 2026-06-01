import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';
import type { HostServer } from '../src/server.js';

type ApprovalRequest = { id: string; promise: Promise<unknown> };
type ApprovalResult = { id: string; ok: boolean };
type ApprovalResolution = { id: string; decision: unknown };
type BatchResolution = { ids: string[]; decision: unknown };

const approvalOkSchema = z.object({
  ok: z.boolean(),
}).passthrough();

const batchApprovalSchema = z.object({
  ids: z.array(z.string()),
  ok: z.boolean(),
  resolved: z.number(),
  results: z.array(z.object({
    id: z.string(),
    ok: z.boolean(),
  })),
  decision: z.unknown(),
}).passthrough();

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-pgw-')); }

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'server should expose an address after listen');
  return `http://127.0.0.1:${address.port}`;
}

async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json() as unknown);
}

function approvalRequest(): ApprovalRequest {
  return { id: 'x', promise: Promise.resolve('once') };
}

test('storeBackend=postgres starts the PG approval store + event bus LISTEN connections', async () => {
  const root = tmp();
  let aStarted = 0;
  let eStarted = 0;
  const approvalRegistry = {
    start: async () => { aStarted += 1; },
    request: approvalRequest,
    resolve: async () => true, respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const runEventBus = {
    start: async () => { eStarted += 1; },
    publish: () => undefined, subscribe: () => (() => undefined), replay: () => [], subscriberCount: () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, storeBackend: 'postgres', databaseUrl: 'postgres://example/db', approvalRegistry, runEventBus });
  await new Promise((r) => setTimeout(r, 20));
  try {
    assert.equal(aStarted, 1, 'approval store LISTEN started');
    assert.equal(eStarted, 1, 'event bus LISTEN started');
  } finally {
    await closeTestServer(server);
  }
});

test('file backend does NOT start LISTEN (single-instance default)', async () => {
  const root = tmp();
  let started = 0;
  const approvalRegistry = {
    start: async () => { started += 1; },
    request: approvalRequest,
    resolve: async () => true, respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  await new Promise((r) => setTimeout(r, 20));
  try {
    assert.equal(started, 0, 'no LISTEN in file mode');
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/approvals/:id awaits an async resolve (PG-style store)', async () => {
  const root = tmp();
  let resolvedWith: ApprovalResolution | null = null;
  const approvalRegistry = {
    start: async () => undefined,
    request: approvalRequest,
    resolve: async (id: string, decision: unknown) => { resolvedWith = { id, decision }; return true; },
    respond: async () => true, cancelByRun: async () => 0, pendingCount: async () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/approvals/apr_123`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'once' }) });
    assert.equal(res.status, 200);
    const body = await responseJson(res, approvalOkSchema);
    assert.equal(body.ok, true, 'awaited async resolve returned true');
    assert.deepEqual(resolvedWith, { id: 'apr_123', decision: 'once' });
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/approvals/batch awaits async resolveMany', async () => {
  const root = tmp();
  let resolvedWith: BatchResolution | null = null;
  const approvalRegistry = {
    start: async () => undefined,
    request: approvalRequest,
    resolve: async () => false,
    resolveMany: async (ids: string[], decision: unknown): Promise<ApprovalResult[]> => {
      resolvedWith = { ids, decision };
      return ids.map((id) => ({ id, ok: id !== 'missing' }));
    },
    respond: async () => true,
    cancelByRun: async () => 0,
    pendingCount: async () => 0,
  };
  const server = createServer({ trustedRoot: root, enableScheduler: false, approvalRegistry });
  const base = await bind(server);
  try {
    const res = await fetch(`${base}/api/approvals/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['apr_a', 'missing', 'apr_a'], decision: 'session' }),
    });
    assert.equal(res.status, 200);
    const body = await responseJson(res, batchApprovalSchema);
    assert.deepEqual(body.ids, ['apr_a', 'missing']);
    assert.equal(body.ok, false);
    assert.equal(body.resolved, 1);
    assert.deepEqual(body.results, [{ id: 'apr_a', ok: true }, { id: 'missing', ok: false }]);
    assert.equal(body.decision, 'session');
    assert.deepEqual(resolvedWith, { ids: ['apr_a', 'missing'], decision: 'session' });
  } finally {
    await closeTestServer(server);
  }
});
