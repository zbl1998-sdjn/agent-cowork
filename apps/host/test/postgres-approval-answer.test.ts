import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePostgresApprovalAnswer,
  encodePostgresApprovalAnswer,
  POSTGRES_APPROVAL_ANSWER_MAX_BYTES,
} from '../src/storage/postgres-approval-answer.js';
import { reconcilePersistedApproval } from '../src/storage/postgres-approval-support.js';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

type Notification = { payload?: string | null };
type NotificationHandler = (message: Notification) => void;
type AnswerRow = {
  id: string;
  runId: unknown;
  tenantId: unknown;
  userId: unknown;
  kind: unknown;
  status: 'pending' | 'resolved';
  decision: string | null;
};

function pgText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function answerCluster() {
  const rows = new Map<string, AnswerRow>();
  const listeners = new Set<NotificationHandler>();
  const queries: Array<{ text: string; params: unknown[] }> = [];

  function notify(id: string, channel: unknown): void {
    const message = { payload: JSON.stringify({ id }), channel: String(channel) };
    for (const handler of listeners) handler(message);
  }

  return {
    rows,
    queries,
    makeClient() {
      return {
        on(event: string, handler: NotificationHandler): void {
          if (event === 'notification') listeners.add(handler);
        },
        async query(text: string, params: unknown[] = []) {
          const sql = text.replace(/\s+/gu, ' ').trim();
          queries.push({ text: sql, params });
          if (sql.startsWith('LISTEN')) return { rows: [] };
          if (sql.startsWith('INSERT INTO pending_approvals')) {
            const row: AnswerRow = {
              id: String(params[0]),
              runId: params[1],
              tenantId: params[2],
              userId: params[3],
              kind: params[4],
              status: 'pending',
              decision: null,
            };
            rows.set(row.id, row);
            return { rowCount: 1, rows: [] };
          }
          if (sql.startsWith('WITH resolved AS')) {
            const row = rows.get(String(params[0]));
            const expectsQuestion = sql.includes("kind='question'");
            const kindMatches = expectsQuestion ? row?.kind === 'question' : row?.kind !== 'question';
            if (
              row?.status === 'pending'
              && row.tenantId === params[2]
              && row.userId === params[3]
              && kindMatches
            ) {
              row.status = 'resolved';
              row.decision = pgText(params[1]);
              notify(row.id, params[4]);
              return { rowCount: 1, rows: [{ id: row.id }] };
            }
            return { rowCount: 0, rows: [] };
          }
          if (sql.startsWith('WITH cancelled AS')) {
            const matched: Array<{ id: string }> = [];
            for (const row of rows.values()) {
              if (
                row.status === 'pending'
                && row.runId === params[0]
                && row.tenantId === params[1]
                && row.userId === params[2]
              ) {
                row.status = 'resolved';
                row.decision = row.kind === 'question' ? pgText(params[3]) : 'reject';
                matched.push({ id: row.id });
              }
            }
            for (const row of matched) notify(row.id, params[4]);
            return { rowCount: matched.length, rows: matched };
          }
          if (sql.startsWith('SELECT status, decision, kind FROM pending_approvals')) {
            const row = rows.get(String(params[0]));
            if (!row || row.tenantId !== params[1] || row.userId !== params[2]) {
              return { rowCount: 0, rows: [] };
            }
            return {
              rowCount: 1,
              rows: [{ status: row.status, decision: row.decision, kind: row.kind }],
            };
          }
          return { rowCount: 0, rows: [] };
        },
      };
    },
    resolveRaw(id: string, decision: string): void {
      const row = rows.get(id);
      if (!row) throw new Error('missing fake approval row');
      row.status = 'resolved';
      row.decision = decision;
      notify(id, 'kcw_approvals');
    },
  };
}

test('versioned PostgreSQL question envelopes preserve every JSON value class', () => {
  const values: unknown[] = [
    null,
    '方案B',
    42.5,
    false,
    ['a', 2, true, null],
    { selected: 'B', nested: { score: 3 }, items: [1, 2] },
  ];
  for (const value of values) {
    const encoded = encodePostgresApprovalAnswer(value);
    assert.ok(Buffer.byteLength(encoded, 'utf8') <= POSTGRES_APPROVAL_ANSWER_MAX_BYTES);
    assert.deepEqual(decodePostgresApprovalAnswer(encoded), value);
  }
});

test('question envelope encoding rejects values that cannot round-trip faithfully', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const shared = { value: 1 };
  const sparse = new Array(2);
  sparse[1] = 'present';
  const accessor = Object.defineProperty({}, 'answer', {
    enumerable: true,
    get() { throw new Error('answer-secret'); },
  });
  const symbolKey = { answer: 'ok' };
  Object.defineProperty(symbolKey, Symbol('hidden'), { value: true, enumerable: true });
  const extraArray = ['ok'];
  Object.defineProperty(extraArray, 'extra', { value: true, enumerable: true });

  for (const value of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    1n,
    Symbol('answer'),
    () => 'answer',
    new Date(),
    new Map(),
    Object.create(null),
    circular,
    [shared, shared],
    sparse,
    accessor,
    symbolKey,
    extraArray,
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { constructor: 'blocked' },
    { prototype: 'blocked' },
    new Proxy({}, {
      ownKeys() { throw new Error('proxy-answer-secret'); },
    }),
  ]) {
    assert.throws(
      () => encodePostgresApprovalAnswer(value),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^PostgresApprovalStore: question answer /u);
        assert.doesNotMatch(error.message, /secret|polluted|blocked/u);
        return true;
      },
    );
  }
});

test('question envelope enforces a 64 KiB UTF-8 ceiling', () => {
  assert.throws(
    () => encodePostgresApprovalAnswer('界'.repeat(22_000)),
    new RegExp(String(POSTGRES_APPROVAL_ANSWER_MAX_BYTES) + '-byte limit', 'u'),
  );
});

test('question envelope bounds the entire reflected value tree', () => {
  const wide = Object.fromEntries(
    Array.from({ length: 10_001 }, (_value, index) => ['k' + String(index), index]),
  );
  assert.throws(
    () => encodePostgresApprovalAnswer(wide),
    /question answer must be canonical JSON/u,
  );
});

test('corrupt, raw, non-v1, and dangerous envelopes never authorize a question', async () => {
  const invalid = [
    'reject',
    '{not-json',
    '{"v":2,"value":"reject"}',
    '{"v":1}',
    '{"v":1,"v":1,"value":"reject"}',
    '{"value":"reject","v":1}',
    '{"v":1, "value":"reject"}',
    '{"v":1,"value":{"constructor":"reject"}}',
    '{"v":1,"value":{"__proto__":{"polluted":true}}}',
  ];
  for (const decision of invalid) {
    let settled = false;
    const errors: string[] = [];
    await reconcilePersistedApproval({
      id: 'apr_invalid',
      meta: { tenantId: 'tenant-a', userId: 'user-a', kind: 'question' },
      persistence: Promise.resolve(),
      read: async () => ({ status: 'resolved', decision, kind: 'question' }),
      isCurrent: () => true,
      settle: () => { settled = true; },
      reportError: (message) => errors.push(message),
    }, 1);
    assert.equal(settled, false);
    assert.deepEqual(errors, ['notification reconciliation failed after bounded retries']);
  }
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
});

test('notification reconciliation retries a bounded number without leaking causes', async () => {
  let reads = 0;
  const errors: string[] = [];
  await reconcilePersistedApproval({
    id: 'apr_retry',
    meta: { tenantId: 'tenant-a', userId: 'user-a', kind: 'question' },
    persistence: Promise.resolve(),
    read: async () => {
      reads += 1;
      throw new Error('postgres://user:password@host/db answer-secret');
    },
    isCurrent: () => true,
    settle: () => { throw new Error('a failed read must not settle'); },
    reportError: (message) => errors.push(message),
  });
  assert.equal(reads, 3);
  assert.deepEqual(errors, ['notification reconciliation failed after bounded retries']);
  assert.doesNotMatch(errors.join(' '), /password|answer-secret/u);
});

test('question answers retain type and null across store instances', async () => {
  const cluster = answerCluster();
  let nextId = 0;
  const instanceA = new PostgresApprovalStore({
    client: cluster.makeClient(),
    generateId: () => 'apr_answer_' + String(nextId += 1),
    pruneIntervalMs: 0,
  });
  const instanceB = new PostgresApprovalStore({
    client: cluster.makeClient(),
    pruneIntervalMs: 0,
  });
  await instanceA.start();
  await instanceB.start();

  for (const value of [null, 'B', 7, false, ['B'], { selected: 'B' }]) {
    const approval = instanceA.request({
      runId: 'run-answer',
      tenantId: 'tenant-a',
      userId: 'user-a',
      kind: 'question',
    });
    await approval.ready;
    assert.equal(
      await instanceB.respond(
        approval.id,
        value,
        { tenantId: 'tenant-a', userId: 'user-a' },
      ),
      true,
    );
    assert.deepEqual(await approval.promise, value);
  }
});

test('a raw resolved question decision does not settle a cross-instance waiter', async () => {
  const cluster = answerCluster();
  const instanceA = new PostgresApprovalStore({
    client: cluster.makeClient(),
    generateId: () => 'apr_raw_question',
    pruneIntervalMs: 0,
  });
  await instanceA.start();
  const approval = instanceA.request({
    runId: 'run-raw',
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'question',
  });
  await approval.ready;
  cluster.resolveRaw(approval.id, 'reject');

  const outcome = await Promise.race([
    approval.promise.then(() => 'settled'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 15)),
  ]);
  assert.equal(outcome, 'pending');
  instanceA.cancelAll();
  assert.equal(await approval.promise, 'reject');
});

test('cancelByRun stores an envelope only for questions and notifies through parameter five', async () => {
  const cluster = answerCluster();
  const store = new PostgresApprovalStore({
    client: cluster.makeClient(),
    pruneIntervalMs: 0,
  });
  await store.start();
  await store.cancelByRun('run-cancel', { tenantId: 'tenant-a', userId: 'user-a' });

  const query = cluster.queries.find(({ text }) => text.startsWith('WITH cancelled AS'));
  assert.ok(query);
  assert.match(
    query.text,
    /decision=CASE WHEN kind='question' THEN \$4 ELSE 'reject' END/u,
  );
  assert.match(query.text, /pg_notify\(\$5,/u);
  assert.equal(decodePostgresApprovalAnswer(query.params[3]), 'reject');
  assert.equal(query.params[4], 'kcw_approvals');
});
