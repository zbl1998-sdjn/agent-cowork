import assert from 'node:assert/strict';
import test from 'node:test';

import { PostgresApprovalStore } from '../../apps/host/src/storage/postgres-approvals.js';
import {
  applyPostgresMigrations,
  createSchemaClient,
  queryRows,
  scopedPostgresUrl,
  waitUntil,
  withEphemeralSchema,
} from './postgres-integration-harness.js';

const scope = Object.freeze({ tenantId: 'tenant-a', userId: 'user-a' });

async function closeResources(
  stores: PostgresApprovalStore[],
  clients: Array<{ end(): Promise<void> }>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const result of await Promise.allSettled(stores.map((store) => store.stop()))) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  for (const result of await Promise.allSettled(clients.map((client) => client.end()))) {
    if (result.status === 'rejected') errors.push(result.reason);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'PostgreSQL approval cleanup failed');
}

test('two real PostgreSQL connections resolve approvals through LISTEN/NOTIFY', async () => {
  await withEphemeralSchema(async (context) => {
    await applyPostgresMigrations(context.client);
    const stores: PostgresApprovalStore[] = [];
    const clients: Array<{ end(): Promise<void> }> = [];
    try {
      const listener = await createSchemaClient(context);
      clients.push(listener);
      const resolver = await createSchemaClient(context);
      clients.push(resolver);
      const A = new PostgresApprovalStore({
        client: listener,
        generateId: () => 'apr_real_notify',
        pruneIntervalMs: 0,
      });
      const B = new PostgresApprovalStore({ client: resolver, pruneIntervalMs: 0 });
      stores.push(A, B);
      await A.start();
      await B.start();
      const approval = A.request({ ...scope, runId: 'run-real-notify', kind: 'tool' });
      await approval.ready;

      assert.equal(
        await B.resolve(approval.id, 'once', { tenantId: 'tenant-a', userId: 'user-b' }),
        false,
      );
      assert.equal(await B.resolve(approval.id, 'once', scope), true);
      assert.equal(await waitUntil(approval.promise), 'once');
    } finally {
      await closeResources(stores, clients);
    }
  });
});

test('an owned listener catches up a resolution committed during a disconnect', async () => {
  await withEphemeralSchema(async (context) => {
    await applyPostgresMigrations(context.client);
    const stores: PostgresApprovalStore[] = [];
    const clients: Array<{ end(): Promise<void> }> = [];
    try {
      const resolver = await createSchemaClient(context);
      clients.push(resolver);
      const applicationName = `kcw_it_${context.schema}`;
      const errors: string[] = [];
      const A = new PostgresApprovalStore({
        connectionString: scopedPostgresUrl(context, applicationName),
        generateId: () => 'apr_real_catch_up',
        pruneIntervalMs: 0,
        reconnectAttempts: 3,
        reconnectDelayMs: 250,
        onError: (message) => errors.push(message),
      });
      const B = new PostgresApprovalStore({ client: resolver, pruneIntervalMs: 0 });
      stores.push(A, B);
      await A.start();
      await B.start();
      const approval = A.request({ ...scope, runId: 'run-real-catch-up', kind: 'tool' });
      await approval.ready;

      const backends = await queryRows(
        context.control,
        `SELECT pid FROM pg_stat_activity
         WHERE datname=current_database() AND application_name=$1`,
        [applicationName],
      );
      assert.equal(backends.length, 1, 'the test must target exactly one owned listener');
      const pid = backends[0]?.pid;
      assert.equal(typeof pid, 'number');
      await context.control.query('SELECT pg_terminate_backend($1)', [pid]);
      await waitUntil(
        new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 5_000;
          const check = (): void => {
            if (errors.some((message) => message.includes('LISTEN client'))) resolve();
            else if (Date.now() >= deadline) reject(new Error('LISTEN disconnect was not observed'));
            else setTimeout(check, 10);
          };
          check();
        }),
      );

      assert.equal(await B.resolve(approval.id, 'session', scope), true);
      assert.equal(await waitUntil(approval.promise, 8_000), 'session');
      assert.equal(
        errors.some((message) => /password|KCW_TEST_POSTGRES_URL/u.test(message)),
        false,
      );
    } finally {
      await closeResources(stores, clients);
    }
  });
});
