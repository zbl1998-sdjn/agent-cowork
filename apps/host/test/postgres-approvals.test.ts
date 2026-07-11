import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

type PendingApprovalRow = {
  id: string;
  run_id: unknown;
  tenant_id: unknown;
  user_id?: unknown;
  kind?: unknown;
  status: 'pending' | 'resolved' | 'expired';
  decision: unknown;
};

type PgNotification = { channel?: string; payload?: string | null };
type QueryResult = { rows?: Array<Record<string, unknown>>; rowCount?: number };
type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;
type NotificationHandler = (message: PgNotification) => void;

function flushAsyncInsert(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | Error | 'unbounded'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then((value) => value, (error: unknown) => error instanceof Error ? error : new Error(String(error))),
      new Promise<'unbounded'>((resolve) => { timer = setTimeout(() => resolve('unbounded'), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Shared mock "Postgres cluster": one table + one NOTIFY bus. This lets two
// store instances simulate two host processes behind a load balancer.
function mockCluster(): {
  makeClient: () => {
    query: QueryFn;
    on: (event: string, handler: (...args: never[]) => void) => void;
    removeListener: (event: string, handler: (...args: never[]) => void) => void;
  };
  rows: Map<string, PendingApprovalRow>;
  notify: (payload: Record<string, unknown>) => void;
  queries: string[];
} {
  const rows = new Map<string, PendingApprovalRow>();
  const listeners = new Set<NotificationHandler>();
  const queries: string[] = [];

  function makeClient() {
    return {
      async query(text: string, params: unknown[] = []): Promise<QueryResult> {
        const normalized = text.replace(/\s+/g, ' ').trim();
        queries.push(normalized);
        if (normalized.startsWith('LISTEN')) return { rows: [] };
        if (normalized.startsWith('SELECT pg_notify')) {
          for (const handler of listeners) handler({ channel: String(params[0] || ''), payload: String(params[1] || '') });
          return { rows: [] };
        }
        if (normalized.startsWith('INSERT INTO pending_approvals')) {
          const [id, run_id, tenant_id, user_id, kind] = params;
          const rowId = String(id || '');
          rows.set(rowId, { id: rowId, run_id, tenant_id, user_id, kind, status: 'pending', decision: null });
          return { rowCount: 1 };
        }
        if (normalized.startsWith('WITH resolved AS') && normalized.includes('WHERE id=')) {
          const [id, decision, tenantId, userId, channel] = params;
          const row = rows.get(String(id || ''));
          const scopeOk = !!row && row.tenant_id === tenantId && row.user_id === userId;
          const kindOk = !!row
            && (!normalized.includes("kind='question'") || row.kind === 'question')
            && (!normalized.includes("kind IS NULL OR kind<>'question'") || row.kind !== 'question');
          if (row && row.status === 'pending' && scopeOk && kindOk) {
            row.status = 'resolved';
            row.decision = decision;
            for (const handler of listeners) handler({ channel: String(channel || ''), payload: JSON.stringify({ id: row.id }) });
            return { rows: [{ id: row.id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith('WITH cancelled AS') && normalized.includes('WHERE run_id=')) {
          const [runId, tenantId, userId, questionDecision, channel] = params;
          const out: Array<{ id: string }> = [];
          for (const row of rows.values()) {
            if (row.run_id === runId && row.status === 'pending' && row.tenant_id === tenantId && row.user_id === userId) {
              row.status = 'resolved';
              row.decision = row.kind === 'question' ? questionDecision : 'reject';
              out.push({ id: row.id });
            }
          }
          for (const item of out) {
            for (const handler of listeners) handler({ channel: String(channel || ''), payload: JSON.stringify({ id: item.id }) });
          }
          return { rows: out, rowCount: out.length };
        }
        if (normalized.startsWith('WITH expired AS')) {
          const channel = params[1];
          const out: Array<{ id: string }> = [];
          for (const row of rows.values()) {
            if (row.status === 'pending') {
              row.status = 'expired';
              row.decision = 'reject';
              out.push({ id: row.id });
            }
          }
          for (const item of out) {
            for (const handler of listeners) handler({ channel: String(channel || ''), payload: JSON.stringify({ id: item.id }) });
          }
          return { rows: out, rowCount: out.length };
        }
        if (normalized.startsWith('SELECT status, decision, kind FROM pending_approvals')) {
          const [id, tenantId, userId] = params;
          const row = rows.get(String(id || ''));
          if (!row || row.tenant_id !== tenantId || row.user_id !== userId) return { rows: [], rowCount: 0 };
          return { rows: [{ status: row.status, decision: row.decision, kind: row.kind }], rowCount: 1 };
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
      on(event: string, handler: (...args: never[]) => void) {
        if (event === 'notification') {
          listeners.add(handler as unknown as NotificationHandler);
        }
      },
      removeListener(event: string, handler: (...args: never[]) => void) {
        if (event === 'notification') {
          listeners.delete(handler as unknown as NotificationHandler);
        }
      },
    };
  }
  return {
    makeClient,
    rows,
    notify(payload) {
      for (const handler of listeners) handler({ channel: 'kcw_approvals', payload: JSON.stringify(payload) });
    },
    queries,
  };
}

test('cross-instance: an approval requested on A is resolved by B (via NOTIFY)', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r1', tenantId: 't1', userId: 'u1', kind: 'approval' });
  await flushAsyncInsert();
  const ok = await B.resolve(id, 'once', { tenantId: 't1', userId: 'u1' });
  assert.equal(ok, true);
  assert.equal(await promise, 'once', 'A\'s awaiting promise resolved by B across instances');
});

test('notification payloads cannot authorize without a matching durable row state', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_untrusted_notify' });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const approval = A.request({ runId: 'r-notify', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();

  cluster.notify({ id: approval.id, decision: 'once' });
  const early = await Promise.race([
    approval.promise.then(() => 'resolved'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
  ]);
  assert.equal(early, 'pending');
  assert.equal(await B.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await approval.promise, 'once');
});

test('durable resolution updates and publishes its notification atomically', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_atomic' });
  await store.start();
  const approval = store.request({ runId: 'r-atomic', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();
  assert.equal(await store.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await approval.promise, 'once');

  const resolutionQueries = cluster.queries.filter((query) => query.includes("SET status='resolved'") || query.startsWith('SELECT pg_notify'));
  assert.equal(resolutionQueries.length, 1);
  assert.match(resolutionQueries[0] || '', /^WITH resolved AS/);
  assert.match(resolutionQueries[0] || '', /pg_notify/);
});

test('cross-instance: tenant-scoped resolve rejects the wrong tenant', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r1', tenantId: 't1', userId: 'u1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await B.resolve(id, 'once', { tenantId: 't2', userId: 'u1' }), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1', userId: 'u1' }), true);
  assert.equal(await promise, 'once');
});

test('cross-instance: same-tenant users cannot resolve or answer each other approvals', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();

  const approval = A.request({ runId: 'r-user-tool', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  const question = A.request({ runId: 'r-user-question', tenantId: 'tenant-a', userId: 'user-a', kind: 'question' });
  await flushAsyncInsert();

  assert.equal(await B.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-b' }), false);
  assert.equal(await B.respond(question.id, '越权答案', { tenantId: 'tenant-a', userId: 'user-b' }), false);
  assert.equal(await B.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await B.respond(question.id, '合法答案', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await approval.promise, 'once');
  assert.equal(await question.promise, '合法答案');
});

test('cross-instance: user-scoped batch resolution rejects a sibling user and missing user context', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const approval = A.request({ runId: 'r-user-batch', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();

  assert.deepEqual(
    await B.resolveMany([approval.id], 'session', { tenantId: 'tenant-a', userId: 'user-b' }),
    [{ id: approval.id, ok: false }],
  );
  assert.equal(await B.resolve(approval.id, 'session', { tenantId: 'tenant-a' }), false);
  assert.equal(await B.resolve(approval.id, 'session', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await approval.promise, 'session');
});

test('cross-instance: exact-ID batch resolve preserves per-id results', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const a = A.request({ runId: 'r1', tenantId: 't1', userId: 'u1', kind: 'approval' });
  const b = A.request({ runId: 'r1', tenantId: 't1', userId: 'u1', kind: 'approval' });
  await flushAsyncInsert();

  assert.deepEqual(await B.resolveMany([a.id, 'ghost', b.id, a.id], 'session', { tenantId: 't1', userId: 'u1' }), [
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
  const { id, promise } = A.request({ runId: 'r1', tenantId: 't1', userId: 'u1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await B.resolve(id, 'once'), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1' }), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1', userId: 'u1' }), true);
  assert.equal(await promise, 'once');
});

test('local resolve and respond use the in-memory fast path even before async insert settles', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_local' });
  await store.start();

  const approval = store.request({ runId: 'r-local', tenantId: 'tenant-a', userId: 'user-a', kind: 'approval' });
  assert.equal(await store.respond(approval.id, 'arbitrary answer', { tenantId: 'tenant-a', userId: 'user-a' }), false);
  assert.equal(await store.resolve(approval.id, 'not-a-valid-decision', { tenantId: 'tenant-a', userId: 'user-a' }), false);
  assert.equal(await store.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await approval.promise, 'once');

  const question = store.request({ runId: 'r-local', tenantId: 'tenant-a', userId: 'user-a', kind: 'question' });
  assert.equal(await store.resolve(question.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), false);
  assert.equal(await store.respond(question.id, { answer: '继续' }, { tenantId: 'tenant-a', userId: 'user-a' }), true);
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
    on(event: string, handler: (...args: never[]) => void): void {
      if (event === 'notification') {
        listeners.add(handler as unknown as NotificationHandler);
      }
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
  const { id, promise } = store.request({ runId: 'r-prune', tenantId: 'tenant-a', userId: 'user-a', kind: 'approval' });
  await flushAsyncInsert();

  assert.equal(await store.prune(1234), 1);
  assert.equal(await promise, 'reject');
  const row = cluster.rows.get(id);
  assert.ok(row);
  assert.equal(row.status, 'expired');
  assert.equal(row.decision, 'reject');
});

test('cross-instance prune cannot be bypassed by a late local approval', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient(), generateId: () => 'apr_prune_race' });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const approval = A.request({ runId: 'r-prune-race', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();

  assert.equal(await B.prune(0), 1);
  assert.equal(await A.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), false);
  assert.equal(await approval.promise, 'reject');
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
  const { id, promise } = A.request({ runId: 'r2', tenantId: 'tenant-a', userId: 'user-a', kind: 'question' });
  await flushAsyncInsert();
  assert.equal(await B.resolve(id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), false, 'decision channel cannot resolve a question');
  await B.respond(id, '方案B', { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(await promise, '方案B');
});

test('cross-instance: free-form answers cannot resolve tool approvals', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const { id, promise } = A.request({ runId: 'r-tool', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();
  assert.equal(await B.respond(id, 'arbitrary answer', { tenantId: 'tenant-a', userId: 'user-a' }), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), true);
  assert.equal(await promise, 'once');
});

test('cross-instance cancelByRun unblocks every pending request for a run', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const a1 = A.request({ runId: 'r3', tenantId: 'tenant-a', userId: 'user-a', kind: 'approval' });
  const a2 = A.request({ runId: 'r3', tenantId: 'tenant-a', userId: 'user-a', kind: 'question' });
  await flushAsyncInsert();
  assert.equal(await A.pendingCount(), 2);
  const count = await B.cancelByRun('r3', { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(count, 2);
  assert.equal(await a1.promise, 'reject');
  assert.equal(await a2.promise, 'reject');
  assert.equal(await A.pendingCount(), 0, 'table drained after cancelByRun');
});

test('cancelByRun is tenant/user scoped even when sibling users share a run id', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start();
  await B.start();
  const userA = A.request({ runId: 'shared-run', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  const userB = A.request({ runId: 'shared-run', tenantId: 'tenant-a', userId: 'user-b', kind: 'tool' });
  await flushAsyncInsert();

  assert.equal(await B.cancelByRun('shared-run', { tenantId: 'tenant-a', userId: 'user-b' }), 1);
  assert.equal(await userB.promise, 'reject');
  assert.equal(cluster.rows.get(userA.id)?.status, 'pending');
  assert.equal(await B.cancelByRun('shared-run', { tenantId: 'tenant-a', userId: 'user-a' }), 1);
  assert.equal(await userA.promise, 'reject');
});

test('cancelByRun releases matching local waiters before a database failure', async () => {
  let inserted = false;
  const client = {
    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN')) return { rows: [] };
      if (text.includes('INSERT INTO pending_approvals')) {
        inserted = true;
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('WHERE run_id=')) throw new Error('database unavailable during cancellation');
      return { rowCount: 0, rows: [] };
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client, generateId: () => 'apr_cancel_failure' });
  await store.start();
  const approval = store.request({ runId: 'r-cancel-failure', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  await flushAsyncInsert();
  assert.equal(inserted, true);

  await assert.rejects(
    () => store.cancelByRun('r-cancel-failure', { tenantId: 'tenant-a', userId: 'user-a' }),
    /cancel query failed/,
  );
  const outcome = await Promise.race([
    approval.promise,
    new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]);
  assert.equal(outcome, 'reject');
});

test('cancelByRun cannot leave a pending row when cancellation races the INSERT', async () => {
  let finishInsert: () => void = () => undefined;
  const insertGate = new Promise<void>((resolve) => { finishInsert = resolve; });
  let rowStatus: 'missing' | 'pending' | 'resolved' = 'missing';
  const client = {
    async query(text: string): Promise<QueryResult> {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('LISTEN')) return { rows: [] };
      if (normalized.startsWith('INSERT INTO pending_approvals')) {
        await insertGate;
        rowStatus = 'pending';
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith('WITH cancelled AS')) {
        if (rowStatus === 'pending') {
          rowStatus = 'resolved';
          return { rowCount: 1, rows: [{ id: 'apr_insert_cancel_race' }] };
        }
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client, generateId: () => 'apr_insert_cancel_race' });
  await store.start();
  const approval = store.request({ runId: 'r-insert-cancel', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  const cancellation = store.cancelByRun('r-insert-cancel', { tenantId: 'tenant-a', userId: 'user-a' });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  finishInsert();

  assert.equal(await cancellation, 1);
  assert.equal(await approval.promise, 'reject');
  assert.equal(rowStatus, 'resolved');
});

test('connectionString creates a PG client for LISTEN, INSERT, and NOTIFY', async () => {
  const calls: unknown[][] = [];
  const listeners = new Set<NotificationHandler>();
  const rows = new Map<string, PendingApprovalRow>();

  class FakeClient {
    constructor(options?: Record<string, unknown>) {
      calls.push(['constructor', options]);
    }

    async connect(): Promise<void> {
      calls.push(['connect']);
    }

    on(event: string, handler: (...args: never[]) => void): void {
      calls.push(['on', event]);
      if (event === 'notification') {
        listeners.add(handler as unknown as NotificationHandler);
      }
    }

    removeListener(event: string, handler: (...args: never[]) => void): void {
      calls.push(['removeListener', event]);
      if (event === 'notification') {
        listeners.delete(handler as unknown as NotificationHandler);
      }
    }

    async query(text: string, params: unknown[] = []): Promise<QueryResult> {
      calls.push(['query', text, params]);
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('INSERT INTO pending_approvals')) {
        const rowId = String(params[0] || '');
        rows.set(rowId, { id: rowId, run_id: params[1], tenant_id: params[2], user_id: params[3], kind: params[4], status: 'pending', decision: null });
        return { rowCount: 1, rows: [] };
      }
      if (normalized.startsWith('WITH resolved AS')) {
        const row = rows.get(String(params[0] || ''));
        if (row && row.status === 'pending' && row.tenant_id === params[2] && row.user_id === params[3]) {
          row.status = 'resolved';
          row.decision = params[1];
          for (const handler of listeners) handler({ channel: String(params[4] || ''), payload: JSON.stringify({ id: row.id }) });
          return { rowCount: 1, rows: [{ id: row.id }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (normalized.startsWith('SELECT status, decision, kind FROM pending_approvals')) {
        const row = rows.get(String(params[0] || ''));
        if (!row || row.tenant_id !== params[1] || row.user_id !== params[2]) return { rows: [], rowCount: 0 };
        return { rows: [{ status: row.status, decision: row.decision, kind: row.kind }], rowCount: 1 };
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
  const { id, promise } = store.request({ runId: 'r-conn', tenantId: 'tenant-1', userId: 'user-1', kind: 'approval' });
  await flushAsyncInsert();
  assert.equal(await store.resolve(id, 'once', { tenantId: 'tenant-1', userId: 'user-1' }), true);
  assert.equal(await promise, 'once');
  assert.deepEqual(calls[0], ['constructor', {
    connectionString: 'postgres://example/db',
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    statement_timeout: 10000,
  }]);
  assert.equal(calls.some((call) => call[0] === 'connect'), true);
  assert.equal(calls.some((call) => call[0] === 'query' && call[1] === 'LISTEN kcw_approvals'), true);
});

test('PostgresApprovalStore fails fast without connection settings or a pg Client export', async () => {
  await assert.rejects(() => new PostgresApprovalStore({}).start(), /client or connectionString/);
  await assert.rejects(
    () => new PostgresApprovalStore({ connectionString: 'postgres://example/db', pg: {} }).start(),
    /Client export/,
  );
});

test('an injected LISTEN client has an application-level query timeout', async () => {
  const client = {
    async query(): Promise<QueryResult> {
      return new Promise<QueryResult>(() => undefined);
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client, queryTimeoutMs: 5, pruneIntervalMs: 0 });

  const outcome = await settleWithin(store.start(), 50);

  assert.ok(outcome !== 'unbounded');
  assert.match(String(outcome), /LISTEN query timed out after 5ms/i);
});

test('an injected query pool has an application-level query timeout', async () => {
  const client = {
    async query(): Promise<QueryResult> { return { rows: [] }; },
    on(): void { return undefined; },
  };
  const pool = {
    async query(): Promise<QueryResult> {
      return new Promise<QueryResult>(() => undefined);
    },
  };
  const store = new PostgresApprovalStore({
    client,
    pool,
    generateId: () => 'apr_pool_timeout',
    queryTimeoutMs: 5,
    pruneIntervalMs: 0,
  });
  await store.start();
  const approval = store.request({ runId: 'r-timeout', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });

  const outcome = await settleWithin(approval.ready, 50);

  assert.ok(outcome !== 'unbounded');
  assert.ok(outcome instanceof Error);
  assert.match(String((outcome as Error & { cause?: unknown }).cause), /INSERT query timed out after 5ms/i);
});

test('PostgresApprovalStore accepts only one lowercase PostgreSQL channel identifier', () => {
  assert.doesNotThrow(() => new PostgresApprovalStore({
    client: mockCluster().makeClient(),
    channel: 'a'.repeat(63),
  }));
  for (const channel of [
    'approvals;select x',
    'Approvals',
    'approvals.events',
    'a'.repeat(64),
  ]) {
    assert.throws(
      () => new PostgresApprovalStore({ client: mockCluster().makeClient(), channel }),
      /invalid channel name/,
    );
  }
});

test('request rejects and removes its local waiter when PostgreSQL persistence fails', async () => {
  const client = {
    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN')) return { rows: [] };
      if (text.includes('INSERT INTO pending_approvals')) throw new Error('database unavailable');
      return { rowCount: 0, rows: [] };
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client, generateId: () => 'apr_insert_failure' });
  await store.start();
  const approval = store.request({ runId: 'r-failure', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  const outcome = await Promise.race([
    approval.promise.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
  ]);

  assert.ok(outcome !== 'timed-out', 'persistence failure must not leave an unbounded pending promise');
  assert.match(String(outcome), /approval persistence failed/i);
  assert.equal(await store.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-a' }), false);
});

test('request exposes durable readiness before an approval id may be published', async () => {
  let finishInsert: () => void = () => undefined;
  const insertGate = new Promise<void>((resolve) => { finishInsert = resolve; });
  const client = {
    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN')) return { rows: [] };
      if (text.includes('INSERT INTO pending_approvals')) {
        await insertGate;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client, generateId: () => 'apr_ready' });
  await store.start();
  const approval = store.request({ runId: 'r-ready', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  assert.ok(approval.ready, 'PostgreSQL requests must expose their INSERT readiness');
  let ready = false;
  void approval.ready.then(() => { ready = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(ready, false);
  finishInsert();
  await approval.ready;
  assert.equal(ready, true);
  await store.cancelByRun('r-ready', { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(await approval.promise, 'reject');
});

test('start retries LISTEN after a failed first attempt', async () => {
  let listenCalls = 0;
  const client = {
    async query(text: string): Promise<QueryResult> {
      if (text.startsWith('LISTEN')) {
        listenCalls += 1;
        if (listenCalls === 1) throw new Error('temporary LISTEN failure');
      }
      return { rows: [] };
    },
    on(): void { return undefined; },
  };
  const store = new PostgresApprovalStore({ client });
  await assert.rejects(() => store.start(), /LISTEN query failed/);
  await store.start();
  assert.equal(listenCalls, 2);
});

test('PostgreSQL approvals use high-entropy ids and enforce a bounded local queue', async () => {
  const cluster = mockCluster();
  const store = new PostgresApprovalStore({ client: cluster.makeClient(), maxPending: 1 });
  await store.start();
  const first = store.request({ runId: 'r-capacity', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' });
  assert.match(first.id, /^apr_[0-9a-f]{32}$/);
  assert.throws(
    () => store.request({ runId: 'r-capacity-2', tenantId: 'tenant-a', userId: 'user-a', kind: 'tool' }),
    /capacity/i,
  );
  await flushAsyncInsert();
  await store.cancelByRun('r-capacity', { tenantId: 'tenant-a', userId: 'user-a' });
  assert.equal(await first.promise, 'reject');
});

test('request fails closed before persistence when tenant or user scope is missing', () => {
  const store = new PostgresApprovalStore({ client: mockCluster().makeClient() });
  assert.throws(() => store.request({ tenantId: 'tenant-a', kind: 'tool' }), /tenantId and userId/);
  assert.throws(() => store.request({ userId: 'user-a', kind: 'tool' }), /tenantId and userId/);
});
