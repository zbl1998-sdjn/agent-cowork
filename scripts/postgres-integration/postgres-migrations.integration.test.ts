import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPostgresMigrations,
  queryRows,
  withEphemeralSchema,
} from './postgres-integration-harness.js';

test('fresh migrations are idempotent and install the approval scope contract', async () => {
  await withEphemeralSchema(async ({ client }) => {
    await applyPostgresMigrations(client);

    const columns = await queryRows(
      client,
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND table_name='pending_approvals'
         AND column_name='user_id'`,
    );
    assert.deepEqual(columns, [{
      data_type: 'text',
      is_nullable: 'YES',
      column_default: null,
    }]);

    const constraints = await queryRows(
      client,
      `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid='pending_approvals'::regclass
         AND conname='pending_approvals_pending_scope_check'`,
    );
    assert.equal(constraints.length, 1);
    assert.equal(constraints[0]?.convalidated, true);
    assert.match(String(constraints[0]?.definition), /tenant_id/u);
    assert.match(String(constraints[0]?.definition), /user_id/u);

    const indexes = await queryRows(
      client,
      `SELECT pg_get_indexdef(indexrelid) AS definition,
              pg_get_expr(indpred, indrelid) AS predicate
       FROM pg_index
       WHERE indexrelid='pending_approvals_tenant_user_pending'::regclass`,
    );
    assert.equal(indexes.length, 1);
    assert.match(String(indexes[0]?.definition), /\(tenant_id, user_id\)/u);
    assert.match(String(indexes[0]?.predicate), /status = 'pending'/u);

    await assert.rejects(
      () => client.query(
        `INSERT INTO pending_approvals (id, tenant_id, user_id, status)
         VALUES ('missing_user', 'tenant-a', NULL, 'pending')`,
      ),
      /pending_approvals_pending_scope_check/u,
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO pending_approvals (id, tenant_id, user_id, status)
         VALUES ('invalid_user', 'tenant-a', E'user-a\\n', 'pending')`,
      ),
      /pending_approvals_pending_scope_check/u,
    );
    await client.query(
      `INSERT INTO pending_approvals (id, tenant_id, user_id, status)
       VALUES ('valid_user', 'tenant-a', 'user-a', 'pending')`,
    );

    await applyPostgresMigrations(client);
    const rows = await queryRows(
      client,
      `SELECT id, status FROM pending_approvals WHERE id='valid_user'`,
    );
    assert.deepEqual(rows, [{ id: 'valid_user', status: 'pending' }]);
  });
});

test('0003 to 0004 expires ownerless legacy pending approvals without altering resolved rows', async () => {
  await withEphemeralSchema(async ({ client }) => {
    await applyPostgresMigrations(client, { through: 3 });
    await client.query(
      `INSERT INTO pending_approvals (id, tenant_id, status)
       VALUES ('legacy_pending', 'tenant-a', 'pending'),
              ('legacy_resolved', 'tenant-a', 'resolved')`,
    );

    await applyPostgresMigrations(client, { from: 4 });

    const rows = await queryRows(
      client,
      `SELECT id, user_id, status, decision, resolved_at IS NOT NULL AS has_resolved_at
       FROM pending_approvals
       WHERE id LIKE 'legacy_%'
       ORDER BY id`,
    );
    assert.deepEqual(rows, [
      {
        id: 'legacy_pending',
        user_id: null,
        status: 'expired',
        decision: 'migration_user_scope_required',
        has_resolved_at: true,
      },
      {
        id: 'legacy_resolved',
        user_id: null,
        status: 'resolved',
        decision: null,
        has_resolved_at: false,
      },
    ]);
  });
});

test('0004 detects index drift and rolls back all earlier statements in its transaction', async () => {
  await withEphemeralSchema(async ({ client }) => {
    await applyPostgresMigrations(client, { through: 3 });
    await client.query('ALTER TABLE pending_approvals ADD COLUMN user_id TEXT');
    await client.query(
      `INSERT INTO pending_approvals (id, tenant_id, status)
       VALUES ('rollback_pending', 'tenant-a', 'pending')`,
    );
    await client.query(
      `CREATE INDEX pending_approvals_tenant_user_pending
       ON pending_approvals (tenant_id)
       WHERE status='pending'`,
    );

    await assert.rejects(
      () => applyPostgresMigrations(client, { from: 4 }),
      /PostgreSQL approval migration drift: pending scope index/u,
    );

    const rows = await queryRows(
      client,
      `SELECT status, decision, resolved_at
       FROM pending_approvals
       WHERE id='rollback_pending'`,
    );
    assert.deepEqual(rows, [{ status: 'pending', decision: null, resolved_at: null }]);
    const constraints = await queryRows(
      client,
      `SELECT conname FROM pg_constraint
       WHERE conrelid='pending_approvals'::regclass
         AND conname='pending_approvals_pending_scope_check'`,
    );
    assert.deepEqual(constraints, []);
  });
});

test('0004 rejects a same-name user_id column with an incompatible type', async () => {
  await withEphemeralSchema(async ({ client }) => {
    await applyPostgresMigrations(client, { through: 3 });
    await client.query('ALTER TABLE pending_approvals ADD COLUMN user_id VARCHAR(96)');

    await assert.rejects(
      () => applyPostgresMigrations(client, { from: 4 }),
      /PostgreSQL approval migration drift: user_id column/u,
    );
  });
});
