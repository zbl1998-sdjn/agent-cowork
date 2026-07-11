import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredScope,
  sameScope,
} from '../src/storage/postgres-approval-support.js';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

type Row = {
  id: string;
  runId: unknown;
  tenantId: unknown;
  userId: unknown;
  kind: unknown;
  status: 'pending' | 'resolved';
  decision: unknown;
};

function identityClient() {
  const rows = new Map<string, Row>();
  return {
    rows,
    client: {
      on(): void { return undefined; },
      async query(text: string, params: unknown[] = []) {
        const sql = text.replace(/\s+/gu, ' ').trim();
        if (sql.startsWith('LISTEN')) return { rows: [] };
        if (sql.startsWith('INSERT INTO pending_approvals')) {
          const row: Row = {
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
            row.decision = params[1];
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
              row.decision = 'reject';
              matched.push({ id: row.id });
            }
          }
          return { rowCount: matched.length, rows: matched };
        }
        return { rowCount: 0, rows: [] };
      },
    },
  };
}

test('PostgreSQL approvals reuse the canonical immutable identity scope', () => {
  const scope = requiredScope({ tenantId: 'tenant-a', userId: 'user-a' });
  assert.deepEqual(scope, { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(Object.isFrozen(scope), true);
  assert.equal(sameScope(scope ?? {}, { tenantId: 'tenant-a', userId: 'user-a' }), true);

  for (const value of [
    { tenantId: '', userId: 'user-a' },
    { tenantId: ' tenant-a', userId: 'user-a' },
    { tenantId: 'tenant-a', userId: 'user-a\n' },
    { tenantId: '用户', userId: 'user-a' },
    { tenantId: 'a'.repeat(97), userId: 'user-a' },
    { tenantId: { toString: () => 'tenant-a' }, userId: 'user-a' },
    { tenantId: 'tenant-a' },
    { userId: 'user-a' },
  ]) {
    assert.equal(requiredScope(value), null);
  }
});

test('non-canonical contexts cannot mutate a PostgreSQL approval', async () => {
  const database = identityClient();
  const store = new PostgresApprovalStore({
    client: database.client,
    generateId: () => 'apr_identity',
    pruneIntervalMs: 0,
  });
  await store.start();

  for (const meta of [
    { tenantId: ' tenant-a', userId: 'user-a', kind: 'tool' },
    { tenantId: 'tenant-a', userId: 'user-a\n', kind: 'tool' },
    { tenantId: ['tenant-a'], userId: 'user-a', kind: 'tool' },
    { tenantId: 'tenant-a', kind: 'tool' },
  ]) {
    assert.throws(() => store.request(meta), /tenantId and userId/u);
  }

  const approval = store.request({
    runId: 'run-identity',
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'tool',
  });
  await approval.ready;

  assert.equal(
    await store.resolve(
      approval.id,
      'once',
      { tenantId: ' tenant-a', userId: 'user-a' },
    ),
    false,
  );
  assert.equal(
    await store.respond(
      approval.id,
      'answer',
      { tenantId: 'tenant-a', userId: 'user-a\n' },
    ),
    false,
  );
  assert.equal(
    await store.cancelByRun(
      'run-identity',
      { tenantId: 'tenant-a', userId: { toString: () => 'user-a' } },
    ),
    0,
  );
  assert.equal(database.rows.get(approval.id)?.status, 'pending');

  assert.equal(
    await store.resolve(
      approval.id,
      'once',
      { tenantId: 'tenant-a', userId: 'user-a' },
    ),
    true,
  );
  assert.equal(await approval.promise, 'once');
});
