import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

test('RunsIndex rejects missing or non-canonical owners and provided-invalid filters', () => {
  const index = new RunsIndex({ indexRoot: tempRoot() });
  for (const record of [
    { id: 'missing_user', tenantId: 'tenant_a', status: 'running' },
    { id: 'missing_tenant', userId: 'user_a', status: 'running' },
    { id: 'trimmed_owner', tenantId: ' tenant_a', userId: 'user_a', status: 'running' },
    { id: 'unicode_owner', tenantId: 'tenant_a', userId: '用户', status: 'running' },
  ]) {
    assert.throws(() => index.upsert(record), /canonical tenantId and userId/i);
  }

  index.upsert({ id: 'valid_owner', tenantId: 'tenant_a', userId: 'user_a', status: 'running' });
  assert.throws(() => index.get('valid_owner', { tenantId: undefined }), /identity filter/i);
  assert.throws(() => index.list({ userId: ' user_a' }), /identity filter/i);
  assert.throws(() => index.stats({ tenantId: ['tenant_a'] }), /identity filter/i);
  assert.equal(index.list({ tenantId: 'tenant_a' }).length, 1, 'valid single-field filters remain supported');
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

test('RunsIndex keeps memory aligned with replay when an upsert append fails', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'append_failure', tenantId: 'tenant_a', userId: 'user_a', status: 'running' });
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let eventDescriptor: number | null = null;
  fs.openSync = ((file: string, flags: string | number, mode?: number) => {
    const descriptor = originalOpenSync(file, flags, mode);
    if (file === index.eventFile && flags === 'a') eventDescriptor = descriptor;
    return descriptor;
  }) as typeof fs.openSync;
  fs.writeFileSync = ((file: unknown, ...args: unknown[]) => {
    if (file === eventDescriptor) throw new Error('injected append failure');
    return Reflect.apply(originalWriteFileSync, fs, [file, ...args]);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(
      () => index.upsert({ id: 'append_failure', tenantId: 'tenant_a', userId: 'user_a', status: 'succeeded' }),
      /injected append failure/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(index.get('append_failure')?.status, 'running');
  assert.equal(index.get('append_failure')?.version, 1);
  const replayed = new RunsIndex({ indexRoot: root });
  assert.equal(replayed.get('append_failure')?.status, 'running');
  assert.equal(replayed.get('append_failure')?.version, 1);
});

test('RunsIndex keeps memory aligned with replay when a remove append fails', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'remove_failure', tenantId: 'tenant_a', userId: 'user_a', status: 'running' });
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let eventDescriptor: number | null = null;
  fs.openSync = ((file: string, flags: string | number, mode?: number) => {
    const descriptor = originalOpenSync(file, flags, mode);
    if (file === index.eventFile && flags === 'a') eventDescriptor = descriptor;
    return descriptor;
  }) as typeof fs.openSync;
  fs.writeFileSync = ((file: unknown, ...args: unknown[]) => {
    if (file === eventDescriptor) throw new Error('injected append failure');
    return Reflect.apply(originalWriteFileSync, fs, [file, ...args]);
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(
      () => index.remove('remove_failure', { tenantId: 'tenant_a', userId: 'user_a' }),
      /injected append failure/,
    );
  } finally {
    fs.openSync = originalOpenSync;
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(index.get('remove_failure')?.status, 'running');
  assert.equal(new RunsIndex({ indexRoot: root }).get('remove_failure')?.status, 'running');
});

test('RunsIndex repairs malformed and unterminated JSONL tails before append', () => {
  for (const tailKind of ['malformed', 'valid'] as const) {
    const root = tempRoot();
    const index = new RunsIndex({ indexRoot: root });
    index.upsert({ id: 'first', tenantId: 'tenant_a', userId: 'user_a', type: 'agent', status: 'running' });
    const firstLine = fs.readFileSync(index.eventFile, 'utf8').trimEnd();
    const tail = tailKind === 'malformed'
      ? '{"op":"upsert"'
      : firstLine.replaceAll('"first"', '"unterminated"');
    fs.writeFileSync(index.eventFile, `${firstLine}\n${tail}`, 'utf8');

    index.upsert({ id: 'next', tenantId: 'tenant_a', userId: 'user_a', type: 'agent', status: 'succeeded' });
    const replayed = new RunsIndex({ indexRoot: root });
    assert.equal(replayed.get('first')?.status, 'running');
    assert.equal(replayed.get('next')?.status, 'succeeded');
    assert.equal(replayed.get('unterminated')?.status, tailKind === 'valid' ? 'running' : undefined);
  }
});

test('RunsIndex rejects interior malformed or schema-invalid JSONL events', () => {
  for (const invalid of ['{"op":', 'null', '{"op":"unknown","id":"bad"}']) {
    const root = tempRoot();
    const index = new RunsIndex({ indexRoot: root });
    index.upsert({ id: 'first', tenantId: 'tenant_a', userId: 'user_a', type: 'agent', status: 'running' });
    const validLine = fs.readFileSync(index.eventFile, 'utf8').trimEnd();
    fs.appendFileSync(index.eventFile, `${invalid}\n${validLine}\n`, 'utf8');
    assert.throws(() => new RunsIndex({ indexRoot: root }), /runs-index event|JSONL|JSON/i);
  }
});

test('RunsIndex rejects a complete schema-invalid final JSONL event', () => {
  const root = tempRoot();
  const eventFile = path.join(root, 'index.jsonl');
  const invalid = {
    op: 'upsert',
    id: 'event-id',
    tenantId: 'tenant_a',
    userId: 'user_a',
    record: {
      id: 'record-id',
      tenantId: 'tenant_a',
      userId: 'user_a',
      type: 'agent',
      status: 'running',
      version: 1,
    },
  };
  const raw = `${JSON.stringify(invalid)}\n`;
  fs.writeFileSync(eventFile, raw, 'utf8');

  assert.throws(() => new RunsIndex({ indexRoot: root }), /runs-index event|JSONL/i);
  assert.equal(fs.readFileSync(eventFile, 'utf8'), raw, 'invalid complete tail must remain visible');
});

test('RunsIndex rejects cross-owner upserts and preserves the original owner record', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'owned', tenantId: 'tenant_a', userId: 'user_a', type: 'agent-chat', status: 'running' });

  assert.throws(
    () => index.upsert({ id: 'owned', tenantId: 'tenant_b', userId: 'user_a', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );
  assert.throws(
    () => index.upsert({ id: 'owned', tenantId: 'tenant_a', userId: 'user_b', type: 'agent-chat', status: 'failed' }),
    /another owner/,
  );

  const original = present(index.get('owned', { tenantId: 'tenant_a', userId: 'user_a' }), 'original owner record');
  assert.equal(original.status, 'running');
  assert.equal(original.version, 1);
  assert.equal(index.get('owned', { tenantId: 'tenant_b', userId: 'user_a' }), null);
  assert.equal(index.get('owned', { tenantId: 'tenant_a', userId: 'user_b' }), null);

  fs.appendFileSync(
    index.eventFile,
    [
      JSON.stringify({
        op: 'upsert',
        id: 'owned',
        tenantId: 'tenant_b',
        userId: 'user_a',
        record: { ...original, tenantId: 'tenant_b', status: 'failed', version: 2 },
      }),
      JSON.stringify({ op: 'delete', id: 'owned', tenantId: 'tenant_b', userId: 'user_a' }),
      '',
    ].join('\n'),
    'utf8',
  );
  assert.throws(
    () => new RunsIndex({ indexRoot: root }),
    /owner|runs-index event/i,
  );
});

test('RunsIndex replay rejects events with invalid owners or mismatched record ids', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'safe', tenantId: 'tenant_a', userId: 'user_a', status: 'running' });
  const original = present(index.get('safe'), 'original record');
  fs.appendFileSync(
    index.eventFile,
    [
      JSON.stringify({
        op: 'upsert',
        id: 'safe',
        tenantId: ' tenant_a',
        userId: 'user_a',
        record: { ...original, status: 'failed' },
      }),
      JSON.stringify({
        op: 'upsert',
        id: 'safe',
        tenantId: 'tenant_a',
        userId: 'user_a',
        record: { ...original, id: 'different', status: 'failed' },
      }),
      JSON.stringify({
        op: 'delete',
        id: 'safe',
        tenantId: 'tenant_a',
        userId: undefined,
      }),
      '',
    ].join('\n'),
    'utf8',
  );

  assert.throws(
    () => new RunsIndex({ indexRoot: root }),
    /owner|runs-index event/i,
  );
});

test('RunsIndex atomically rejects a stale independent instance claiming the same id for another owner', () => {
  const root = tempRoot();
  const ownerA = new RunsIndex({ indexRoot: root });
  const ownerB = new RunsIndex({ indexRoot: root });

  ownerA.upsert({ id: 'cross_process_owned', tenantId: 'tenant_a', userId: 'user_a', status: 'running' });
  assert.throws(
    () => ownerB.upsert({ id: 'cross_process_owned', tenantId: 'tenant_a', userId: 'user_b', status: 'failed' }),
    /owner|claim/i,
  );

  const replayed = new RunsIndex({ indexRoot: root });
  assert.equal(replayed.get('cross_process_owned', { tenantId: 'tenant_a', userId: 'user_a' })?.status, 'running');
  assert.equal(replayed.get('cross_process_owned', { tenantId: 'tenant_a', userId: 'user_b' }), null);
});

test('RunsIndex fails closed when an owner claim is malformed', () => {
  const root = tempRoot();
  const id = 'corrupt_owner_claim';
  const claimName = crypto.createHash('sha256').update(id).digest('hex');
  const claimRoot = path.join(root, '.owners');
  fs.mkdirSync(claimRoot, { recursive: true });
  fs.writeFileSync(path.join(claimRoot, `${claimName}.json`), '{', 'utf8');

  const index = new RunsIndex({ indexRoot: root });
  assert.throws(
    () => index.upsert({ id, tenantId: 'tenant_a', userId: 'user_a', status: 'running' }),
    /claim could not be verified/i,
  );
  assert.equal(index.get(id), null);
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
  assert.throws(() => index1.remove('x'), /owner context/);
  assert.equal(index1.remove('x', { tenantId: 't', userId: 'other' }), false);
  assert.ok(index1.get('x', { tenantId: 't', userId: 'u' }));
  assert.equal(index1.remove('x', { tenantId: 't', userId: 'u' }), true);
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

test('RunsIndex.stats applies exact tenant and user scope', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  index.upsert({ id: 'alice', tenantId: 'shared', userId: 'alice', type: 'recipe-run', status: 'succeeded' });
  index.upsert({ id: 'bob', tenantId: 'shared', userId: 'bob', type: 'recipe-run', status: 'failed' });

  const alice = index.stats({ tenantId: 'shared', userId: 'alice' });
  assert.equal(alice.total, 1);
  assert.equal(alice.byStatus.succeeded, 1);
  assert.equal(alice.byStatus.failed, undefined);
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

  assert.throws(
    () => summariseRunForIndex({ id: 'r3', input: { prompt: 42 } }),
    /canonical tenantId and userId/i,
  );
  assert.throws(
    () => summariseRunForIndex(
      { id: 'r4', context: { tenantId: 'tenant_record', userId: 'user_record' } },
      { tenantId: 'tenant_request' },
    ),
    /canonical tenantId and userId/i,
  );
  assert.throws(() => summariseRunForIndex(null), /runRecord required/);
});

test('RunsIndex rejects records without an id', () => {
  const root = tempRoot();
  const index = new RunsIndex({ indexRoot: root });
  assert.throws(() => index.upsert({ tenantId: 't', userId: 'u' }), /id is required/);
});
