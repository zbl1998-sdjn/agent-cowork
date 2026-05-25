import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresApprovalStore } from '../src/storage/postgres-approvals.js';

// A shared mock "Postgres cluster": one table + one NOTIFY bus that delivers to
// every connected client's listener — so two store instances genuinely simulate
// two host instances behind a load balancer.
function mockCluster() {
  const rows = new Map();
  const listeners = new Set();
  function makeClient() {
    return {
      async query(text, params = []) {
        const t = text.replace(/\s+/g, ' ').trim();
        if (t.startsWith('LISTEN')) return { rows: [] };
        if (t.startsWith('SELECT pg_notify')) {
          for (const h of listeners) h({ channel: params[0], payload: params[1] });
          return { rows: [] };
        }
        if (t.startsWith('INSERT INTO pending_approvals')) {
          const [id, run_id, tenant_id, kind] = params;
          rows.set(id, { id, run_id, tenant_id, kind, status: 'pending', decision: null });
          return { rowCount: 1 };
        }
        if (t.startsWith("UPDATE pending_approvals SET status='resolved'") && t.includes('WHERE id=')) {
          const [id, decision, tenantId] = params;
          const r = rows.get(id);
          const tenantOk = !!r && (tenantId ? r.tenant_id == null || r.tenant_id === tenantId : r.tenant_id == null);
          if (r && r.status === 'pending' && tenantOk) {
            r.status = 'resolved'; r.decision = decision; return { rowCount: 1 };
          }
          return { rowCount: 0 };
        }
        if (t.includes('WHERE run_id=') && t.includes('RETURNING id')) {
          const [runId, decision] = params;
          const out = [];
          for (const r of rows.values()) {
            if (r.run_id === runId && r.status === 'pending') { r.status = 'resolved'; r.decision = decision; out.push({ id: r.id }); }
          }
          return { rows: out, rowCount: out.length };
        }
        if (t.startsWith('SELECT COUNT')) {
          let n = 0; for (const r of rows.values()) if (r.status === 'pending') n += 1;
          return { rows: [{ count: n }] };
        }
        return { rows: [] };
      },
      on(evt, h) { if (evt === 'notification') listeners.add(h); },
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
  await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget INSERT land
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
  await new Promise((r) => setTimeout(r, 5));
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
  await new Promise((r) => setTimeout(r, 5));

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
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await B.resolve(id, 'once'), false);
  assert.equal(await B.resolve(id, 'once', { tenantId: 't1' }), true);
  assert.equal(await promise, 'once');
});

test('cross-instance: AskUserQuestion answer text flows from B back to A', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start(); await B.start();
  const { id, promise } = A.request({ runId: 'r2', kind: 'question' });
  await new Promise((r) => setTimeout(r, 5));
  await B.respond(id, '方案B');
  assert.equal(await promise, '方案B');
});

test('cross-instance cancelByRun unblocks every pending request for a run', async () => {
  const cluster = mockCluster();
  const A = new PostgresApprovalStore({ client: cluster.makeClient() });
  const B = new PostgresApprovalStore({ client: cluster.makeClient() });
  await A.start(); await B.start();
  const a1 = A.request({ runId: 'r3', kind: 'approval' });
  const a2 = A.request({ runId: 'r3', kind: 'question' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await A.pendingCount(), 2);
  const n = await B.cancelByRun('r3');
  assert.equal(n, 2);
  assert.equal(await a1.promise, 'reject');
  assert.equal(await a2.promise, 'reject');
  assert.equal(await A.pendingCount(), 0, 'table drained after cancelByRun');
});
