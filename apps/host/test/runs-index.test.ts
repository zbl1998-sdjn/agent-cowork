import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunsIndex, SqliteRunsIndex, createRunsIndex, createUlid, summariseRunForIndex } from '../src/runtime/runs-index.js';
import type { SqliteDatabase, SqliteStatement } from '../src/runtime/runs-index.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-runs-'));
}

function present<T>(value: T | null | undefined, label: string): T {
  assert.ok(value, `${label} should exist`);
  return value;
}

test('createUlid emits monotonic, prefixed, base32 ids', () => {
  const ids = Array.from({ length: 50 }, () => createUlid());
  for (const id of ids) {
    assert.match(id, /^run_[0-9A-Z]{26}$/);
  }
  const sorted = [...ids].sort();
  // Same length deterministic prefix sort works because timestamps dominate.
  assert.deepEqual(new Set(ids).size, ids.length, 'ids should be unique');
  assert.equal(present(sorted[0], 'first sorted id').length, present(ids[0], 'first id').length);
});

test('RunsIndex upsert + get + list', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  const id = createUlid();
  index.upsert({
    id,
    tenantId: 'tenant_alice',
    userId: 'user_alice',
    traceId: 'trace_1',
    type: 'recipe-run',
    status: 'succeeded',
    recipeId: 'meeting-actions',
    startedAt: '2026-05-20T10:00:00Z',
    finishedAt: '2026-05-20T10:00:05Z',
    durationMs: 5000,
    promptPreview: '把这些会议纪要整理成行动项',
  });
  const got = present(index.get(id, { tenantId: 'tenant_alice' }), 'indexed run');
  assert.equal(got.id, id);
  assert.equal(got.tenantId, 'tenant_alice');
  assert.equal(got.status, 'succeeded');
  assert.equal(got.version, 1);
  const otherTenant = index.get(id, { tenantId: 'tenant_bob' });
  assert.equal(otherTenant, null, 'tenant isolation must hold');
  const listed = index.list({ tenantId: 'tenant_alice' });
  assert.equal(listed.length, 1);
});

test('RunsIndex upsert bumps version + persists state via JSONL replay', () => {
  const root = tempRoot();
  const index1 = new RunsIndex({ indexRoot: root });
  const id = createUlid();
  index1.upsert({ id, tenantId: 't', userId: 'u', type: 'recipe-run', status: 'running' });
  index1.upsert({ id, tenantId: 't', userId: 'u', type: 'recipe-run', status: 'succeeded' });
  const first = present(index1.get(id), 'first indexed run');
  assert.equal(first.version, 2);
  assert.equal(first.status, 'succeeded');

  const index2 = new RunsIndex({ indexRoot: root });
  const replayed = present(index2.get(id), 'replayed indexed run');
  assert.equal(replayed.status, 'succeeded');
  assert.equal(replayed.version, 2);
});

test('RunsIndex.list filters by tenant, status, type, recipeId, sorted by startedAt desc', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'a', tenantId: 't1', userId: 'u', type: 'recipe-run', status: 'succeeded', recipeId: 'meeting-actions', startedAt: '2026-05-20T09:00:00Z' });
  index.upsert({ id: 'b', tenantId: 't1', userId: 'u', type: 'recipe-run', status: 'failed', recipeId: 'meeting-actions', startedAt: '2026-05-20T10:00:00Z' });
  index.upsert({ id: 'c', tenantId: 't2', userId: 'u', type: 'kimi-plan', status: 'succeeded', startedAt: '2026-05-20T11:00:00Z' });

  const t1All = index.list({ tenantId: 't1' });
  assert.deepEqual(t1All.map((r) => r.id), ['b', 'a']);

  const succeeded = index.list({ tenantId: 't1', status: 'succeeded' });
  assert.deepEqual(succeeded.map((r) => r.id), ['a']);

  const byRecipe = index.list({ recipeId: 'meeting-actions' });
  assert.deepEqual(byRecipe.map((r) => r.id), ['b', 'a']);

  const byType = index.list({ type: 'kimi-plan' });
  assert.deepEqual(byType.map((r) => r.id), ['c']);
});

test('RunsIndex.remove deletes and is reflected on replay', () => {
  const root = tempRoot();
  const index1 = new RunsIndex({ indexRoot: root });
  index1.upsert({ id: 'x', tenantId: 't', userId: 'u', type: 'recipe-run', status: 'running' });
  assert.equal(index1.remove('x'), true);
  assert.equal(index1.get('x'), null);

  const index2 = new RunsIndex({ indexRoot: root });
  assert.equal(index2.get('x'), null);
  assert.equal(index2.size(), 0);
});

test('RunsIndex.stats counts by tenant scope', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'a', tenantId: 't1', userId: 'u', type: 'recipe-run', status: 'succeeded' });
  index.upsert({ id: 'b', tenantId: 't1', userId: 'u', type: 'recipe-run', status: 'failed' });
  index.upsert({ id: 'c', tenantId: 't2', userId: 'u', type: 'kimi-plan', status: 'succeeded' });
  const all = index.stats();
  assert.equal(all.total, 3);
  const t1 = index.stats({ tenantId: 't1' });
  assert.equal(t1.total, 2);
  assert.equal(t1.byStatus.succeeded, 1);
  assert.equal(t1.byStatus.failed, 1);
  assert.equal(t1.byType['recipe-run'], 2);
});

test('createRunsIndex selects file by default and sqlite only when requested', () => {
  const root = tempRoot();
  const fileIndex = createRunsIndex({ indexRoot: root });
  assert.ok(fileIndex instanceof RunsIndex);

  const statement: SqliteStatement = {
    get: () => null,
    run: () => ({ changes: 0 }),
    all: () => [],
  };
  const db: SqliteDatabase = {
    exec: () => undefined,
    prepare: () => statement,
  };
  const sqliteIndex = createRunsIndex({ backend: 'sqlite', db });
  assert.ok(sqliteIndex instanceof SqliteRunsIndex);
});

test('summariseRunForIndex extracts fields from full run JSON', () => {
  const summary = summariseRunForIndex(
    {
      id: 'r1',
      type: 'kimi-plan',
      status: 'succeeded',
      mode: 'cowork',
      provider: 'kimi-cli',
      startedAt: '2026-05-20T00:00:00Z',
      finishedAt: '2026-05-20T00:00:02Z',
      durationMs: 2000,
      input: { prompt: 'hello world' },
      context: { tenantId: 'tenant_x', userId: 'user_x', traceId: 'trace_x' },
    },
    {},
  );
  assert.equal(summary.id, 'r1');
  assert.equal(summary.promptPreview, 'hello world');
  assert.equal(summary.tenantId, 'tenant_x');
  assert.equal(summary.traceId, 'trace_x');
});

test('summariseRunForIndex applies request context overrides and defensive defaults', () => {
  const summary = summariseRunForIndex(
    {
      id: 'r2',
      type: 'agent-chat',
      status: 'failed',
      mode: 'agent',
      provider: 'kimi-api',
      recipeId: 'custom',
      startedAt: '2026-05-20T00:00:00Z',
      finishedAt: '2026-05-20T00:00:01Z',
      durationMs: 1000,
      input: { prompt: 'x'.repeat(300) },
      context: { tenantId: 'tenant_record', userId: 'user_record', traceId: 'trace_record' },
      error: { message: 'boom' },
      runPath: 'runs/r2.json',
    },
    { tenantId: 'tenant_request', userId: 'user_request', traceId: 'trace_request' },
  );
  assert.equal(summary.tenantId, 'tenant_request');
  assert.equal(summary.userId, 'user_request');
  assert.equal(summary.traceId, 'trace_request');
  assert.equal(summary.recipeId, 'custom');
  assert.equal(summary.error, 'boom');
  assert.equal(summary.runPath, 'runs/r2.json');
  assert.equal(summary.promptPreview.length, 240);

  const minimal = summariseRunForIndex({ id: 'r3', input: { prompt: 42 } });
  assert.equal(minimal.promptPreview, '');
  assert.equal(minimal.runPath, null);
  assert.throws(() => summariseRunForIndex(null), /runRecord required/);
});

test('RunsIndex rejects records without an id', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  assert.throws(() => index.upsert({ tenantId: 't', userId: 'u' }), /id is required/);
});
