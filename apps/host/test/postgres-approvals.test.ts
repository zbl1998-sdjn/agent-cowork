import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

type PendingApprovalRow = {
  id: string;
  run_id: unknown;
  tenant_id: unknown;
  kind?: unknown;
  status: 'pending' | 'resolved';
  decision: unknown;
};

type PgNotification = { channel?: string; payload?: string | null };
type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number };
type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;
type NotificationHandler = (message: PgNotification) => void;

function flushAsyncInsert(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

// Shared mock "Postgres cluster": one table + one NOTIFY bus. This lets two
// store instances simulate two host processes behind a load balancer.
function mockCluster(): {
  makeClient: () => { query: QueryFn; on: (event: 'notification', handler: NotificationHandler) => void };
  rows: Map<string, PendingApprovalRow>;
} {
  const rows = new Map<string, PendingApprovalRow>();
  const listeners = new Set<NotificationHandler>();

  function makeClient() {
    return {
      async query(text: string, params: unknown[] = []): Promise<QueryResult> {
        const normalized = text.replace(/\s+/g, ' ').trim();
        if (normalized.startsWith('LISTEN')) return { rows: [] };
        if (normalized.startsWith('SELECT pg_notify')) {
          for (const handler of listeners) handler({ channel: String(params[0] || ''), payload: String(params[1] || '') });
          return { rows: [] };
        }
        if (normalized.startsWith('INSERT INTO pending_approvals')) {
          const [id, run_id, tenant_id, kind] = params;
          const rowId = String(id || '');
          rows.set(rowId, { id: rowId, run_id, tenant_id, kind, status: 'pending', decision: null });
          return { rowCount: 1 };
        }
        if (normalized.startsWith("UPDATE pending_approvals SET status='resolved'") && normalized.includes('WHERE id=')) {
          const [id, decision, tenantId] = params;
          const row = rows.get(String(id || ''));
          const tenantOk = !!row && (tenantId ? row.tenant_id == null || row.tenant_id === tenantId : row.tenant_id == null);
          if (row && row.status === 'pending' && tenantOk) {
            row.status = 'resolved';
            row.decision = decision;
            return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        if (normalized.includes('WHERE run_id=') && normalized.includes('RETURNING id')) {
          const [runId, decision] = params;
          const out: Array<{ id: string }> = [];
          for (const row of rows.values()) {
            if (row.run_id === runId && row.status === 'pending') {
              row.status = 'resolved';
              row.decision = decision;
              out.push({ id: row.id });
            }
          }
          return { rows: out, rowCount: out.length };
        }
        if (normalized.startsWith("UPDATE pending_approvals SET status='expired'")) {
          const out: Array<{ id: string }> = [];
          for (const row of rows.values()) {
            if (row.status === 'pending') {
              row.status = 'resolved';
              row.decision = 'expired';
              out.push({ id: row.id });
            }
          }
          return { rows: out, rowCount: out.length };
        }
        if (normalized.startsWith('SELECT COUNT')) {
          let count = 0;
          for (const row of rows.values()) {
            if (row.status === 'pending') count += 1;
          }
          return { rows: [{ count }] };
        }
        return { rows: [] };
      },
      on(event: 'notification', handler: NotificationHandler) {
        if (event === 'notification') listeners.add(handler);
      },
    };
  }
  return { makeClient, rows };
}

test('cross-instance: an approval requested on A is resolved by B (via NOTIFY)', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r1', kind: 'approval' });
  await flushAsyncInsert();
  const ok = await B.resolve(id, 'once');
  assert.equal(ok, true);
  assert.equal(await promise, 'once', 'A\'s awaiting promise resolved by B across instances');
});

test('cross-instance: tenant-scoped resolve rejects the wrong tenant', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r1', tenantId: 't1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await B.resolve(id, 'once', { tenantId: 't2' }), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1' }), true);
  assert.equal(await promise, 'once');
});

test('cross-instance: exact-ID batch resolve preserves per-id results', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const a = A.request({ runId: 'r1', tenantId: 't1', kind: 'approval' });
  const b = A.request({ runId: 'r1', tenantId: 't1', kind: 'approval' });
  await flushAsyncInsert();

  assert.deepEqual(await B.resolveMany([a.id, 'ghost', b.id, a.id], 'session', { tenantId: 't1' }), [
    { id: a.id, ok: true },
    { id: 'ghost', ok: false },
    { id: b.id, ok: true },
  ]);
  assert.equal(await a.promise, 'session');
  assert.equal(await b.promise, 'session');
});

test('cross-instance: tenant-scoped resolve also rejects missing tenant context', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r1', tenantId: 't1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await B.resolve(id, 'once'), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1' }), true);
  assert.equal(await promise, 'once');
});

test('local resolve and respond use the in-memory fast path even before async insert settles', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_local' });
  await store.start();

  const approval = store.request({ runId: 'r-local', tenantId: 'tenant-a', kind: 'approval' });
  assert.equal(await store.resolve(approval.id, 'not-a-valid-decision', { tenantId: 'tenant-a' }), true);
  assert.equal(await approval.promise, 'reject', 'invalid approval decision is normalized to reject');

  const question = store.request({ runId: 'r-local', tenantId: 'tenant-a', kind: 'question' });
  assert.equal(await store.respond(question.id, { answer: '继续' }, { tenantId: 'tenant-a' }), true);
  assert.deepEqual(await question.promise, { answer: '继续' });
});

test('start is idempotent and ignores malformed NOTIFY payloads', async () => {
  const calls: string[] = [];
  const listeners = new Set<NotificationHandler>();
  const client = {
    async query(text: string): Promise<QueryResult> {
      calls.push(text);
      return { rows: [] };
    },
    on(_event: 'notification', handler: NotificationHandler): void {
      listeners.add(handler);
    },
  };
  const store = new PostgresApprovalStore({ client });
  await store.start();
  await store.start();
  assert.deepEqual(calls, ['LISTEN kcw_approvals']);
  for (const handler of listeners) {
    handler({ payload: null });
    handler({ payload: '{bad json' });
    handler({ payload: JSON.stringify({ id: 'missing-local', decision: 'once' }) });
  }
  assert.equal(await store.pendingCount(), 0);
});

test('prune expires pending rows and rejects local waiters', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_prune' });
  await store.start();
  const { id, promise } = store.request({ runId: 'r-prune', kind: 'approval' });
  await flushAsyncInsert();

  assert.equal(await store.prune(1234), 1);
  assert.equal(await promise, 'reject');
  const row = cluster.rows.get(id);
  assert.ok(row);
  assert.equal(row.status, 'resolved');
  assert.equal(row.decision, 'expired');
});

test('cancelByRun returns zero without touching the database for empty run ids', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient() });
  await store.start();
  assert.equal(await store.cancelByRun(''), 0);
});

test('cross-instance: AskUserQuestion answer text flows from B back to A', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r2', kind: 'question' });
  await flushAsyncInsert();
  await B.respond(id, '方案B');
  assert.equal(await promise, '方案B');
});

test('cross-instance cancelByRun unblocks every pending request for a run', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const a1 = A.request({ runId: 'r3', kind: 'approval' });
  const a2 = A.request({ runId: 'r3', kind: 'question' });
  await flushAsyncInsert();
  assert.equal(await A.pendingCount(), 2);
  const count = await B.cancelByRun('r3');
  assert.equal(count, 2);
  assert.equal(await a1.promise, 'reject');
  assert.equal(await a2.promise, 'reject');
  assert.equal(await A.pendingCount(), 0, 'table drained after cancelByRun');
});

test('connectionString creates a PG client for LISTEN, INSERT, and NOTIFY', async () => {
  const calls: unknown[][] = [];
  const listeners = new Set<NotificationHandler>();
  const rows = new Map<string, PendingApprovalRow>();

  class FakeClient {
    constructor(options?: Record<string, unknown>) {
      calls.push(['constructor', options?.connectionString]);
    }

    async connect(): Promise<void> {
      calls.push(['connect']);
    }

    on(event: 'notification', handler: NotificationHandler): void {
      calls.push(['on', event]);
      listeners.add(handler);
    }

    async query(text: string, params: unknown[] = []): Promise<QueryResult> {
      calls.push(['query', text, params]);
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO pending_approvals')) {
        const rowId = String(params[0] || '');
        rows.set(rowId, { id: rowId, run_id: null, tenant_id: params[2], status: 'pending', decision: null });
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith("UPDATE pending_approvals SET status='resolved'")) {
        const row = rows.get(String(params[0] || ''));
        if (row && row.status === 'pending') {
          row.status = 'resolved';
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (normalized.startsWith('SELECT pg_notify')) {
        for (const handler of listeners) handler({ channel: String(params[0] || ''), payload: String(params[1] || '') });
        return { rows: [] };
      }
      return { rows: [] };
    }
  }

  const store = new PostgresApprovalStore({
    connectionString: 'postgres://example/db',
    generateId: () => 'apr_conn',
    pg: { Client: FakeClient },
  });
  await store.start();
  const { id, promise } = store.request({ runId: 'r-conn', tenantId: 'tenant-1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await store.resolve(id, 'once', { tenantId: 'tenant-1' }), true);
  assert.equal(await promise, 'once');
  assert.deepEqual(calls[0], ['constructor', 'postgres://example/db']);
  assert.deepEqual(calls[1], ['connect']);
  assert.equal(calls.some((call) => call[0] === 'query' && call[1] === 'LISTEN kcw_approvals'), true);
});

test('PostgresApprovalStore fails fast without connection settings or a pg Client export', async () => {
  await assert.rejects(() => new PostgresApprovalStore({}).start(), /client or connectionString/);
  await assert.rejects(
    () => new PostgresApprovalStore({ connectionString: 'postgres://example/db', pg: {} }).start(),
    /Client export/,
  );
});

test('PostgresApprovalStore rejects unsafe channel names', () => {
  assert.throws(
    () => new PostgresApprovalStore({ client: mockCluster().makeClient(), channel: 'approvals;select x' }),
    /invalid channel name/,
  );
});
