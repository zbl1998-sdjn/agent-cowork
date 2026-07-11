import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPostgresMigrationPlan,
  validatePostgresMigrationNames,
} from '../src/storage/postgres-migration-plan.js';

test('PostgreSQL migration plan is ordered, contiguous, and plan-only', () => {
  const plan = buildPostgresMigrationPlan();

  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.databaseConnected, false);
  assert.deepEqual(
    plan.migrations.map((migration) => migration.file),
    [
      '0001_init.sql',
      '0002_conversation_branches.sql',
      '0003_conversation_workspace_key.sql',
      '0004_pending_approvals_user_scope.sql',
    ],
  );
  for (const migration of plan.migrations) {
    assert.match(migration.sha256, /^[a-f0-9]{64}$/);
    assert.ok(migration.bytes > 0);
  }
});

test('PostgreSQL migration planning fails closed on gaps or malformed names', () => {
  assert.throws(
    () => validatePostgresMigrationNames(['0001_init.sql', '0003_gap.sql']),
    /expected migration 0002/i,
  );
  assert.throws(
    () => validatePostgresMigrationNames(['0001_init.sql', 'not-a-migration.sql']),
    /invalid PostgreSQL migration filename/i,
  );
});

test('PostgreSQL migration planning fails closed when the approval migration changes', () => {
  const sourceDirectory = fileURLToPath(new URL('../src/storage/migrations-postgres/', import.meta.url));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-migrations-'));
  const temporaryDirectory = path.join(temporaryRoot, 'migrations');
  try {
    fs.mkdirSync(temporaryDirectory, { recursive: true });
    for (const file of fs.readdirSync(sourceDirectory).filter((name) => name.endsWith('.sql'))) {
      fs.copyFileSync(path.join(sourceDirectory, file), path.join(temporaryDirectory, file));
    }
    fs.appendFileSync(
      path.join(temporaryDirectory, '0004_pending_approvals_user_scope.sql'),
      '\n-- unintended history rewrite\n',
    );

    assert.throws(
      () => buildPostgresMigrationPlan(temporaryDirectory),
      /published PostgreSQL migration checksum mismatch: 0004_pending_approvals_user_scope\.sql/i,
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
