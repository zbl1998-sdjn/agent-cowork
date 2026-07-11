import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const migrationDirectory = new URL('../src/storage/migrations-postgres/', import.meta.url);

function readMigration(file: string): string {
  return fs.readFileSync(fileURLToPath(new URL(file, migrationDirectory)), 'utf8');
}

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function isCanonicalIdentity(value: string): boolean {
  return value.length >= 1
    && value.length <= 96
    && !/[^A-Za-z0-9_.:-]/u.test(value);
}

test('0004 approval scope migration matches the canonical identity contract', () => {
  const migration = readMigration('0004_pending_approvals_user_scope.sql');

  assert.equal(isCanonicalIdentity('tenant-a:user_1.example'), true);
  assert.equal(isCanonicalIdentity(''), false, 'blank identities must fail');
  assert.equal(isCanonicalIdentity('user-a\n'), false, 'trailing newlines must fail');
  assert.equal(isCanonicalIdentity('用户'), false, 'non-ASCII identities must fail');
  assert.equal(isCanonicalIdentity('a'.repeat(97)), false, '97-character identities must fail');

  assert.equal(
    occurrences(migration, /char_length\(tenant_id\) BETWEEN 1 AND 96/gu),
    3,
    'the legacy UPDATE, parsed contract, and target CHECK must bound tenant_id',
  );
  assert.equal(
    occurrences(migration, /\(tenant_id COLLATE "C"\) !~ '\[\^A-Za-z0-9_\.:-\]'/gu),
    3,
    'the legacy UPDATE, parsed contract, and target CHECK must use C collation for tenant_id',
  );
  assert.equal(
    occurrences(migration, /char_length\(user_id\) BETWEEN 1 AND 96/gu),
    3,
    'the legacy UPDATE, parsed contract, and target CHECK must bound user_id',
  );
  assert.equal(
    occurrences(migration, /\(user_id COLLATE "C"\) !~ '\[\^A-Za-z0-9_\.:-\]'/gu),
    3,
    'the legacy UPDATE, parsed contract, and target CHECK must use C collation for user_id',
  );
  assert.match(
    migration,
    /WHERE status = 'pending'[\s\S]*?\) IS NOT TRUE;/u,
    'legacy NULL or invalid identity pairs must be expired',
  );
  assert.match(
    migration,
    /CHECK \([\s\S]*?\) IS TRUE\s*\) NOT VALID;/u,
    'the CHECK must not let SQL NULL pass',
  );
  assert.doesNotMatch(migration, /BTRIM/iu);
});

test('0004 fails closed when same-name scope objects drift from the target shape', () => {
  const migration = readMigration('0004_pending_approvals_user_scope.sql');

  assert.match(
    migration,
    /FROM pg_catalog\.pg_attribute[\s\S]*?atttypid = 'pg_catalog\.text'::regtype[\s\S]*?RAISE EXCEPTION/u,
    'an existing user_id column must be structurally verified',
  );
  assert.match(
    migration,
    /CREATE TEMP TABLE pending_approvals_scope_contract_0004[\s\S]*?ON COMMIT DROP/u,
    'the expected CHECK and index must be parsed by the running PostgreSQL version',
  );
  assert.match(migration, /actual\.conkey = expected\.conkey/u);
  assert.match(
    migration,
    /actual\.conbin::text[\s\S]*?expected\.conbin::text/u,
    'CHECK expressions must match parsed node trees rather than names alone',
  );
  assert.match(
    migration,
    /COALESCE\(\(to_jsonb\(actual\)->>'conenforced'\)::boolean, TRUE\)[\s\S]*?COALESCE\(\(to_jsonb\(expected\)->>'conenforced'\)::boolean, TRUE\)/u,
    'PG18 NOT ENFORCED constraints must fail drift checks without breaking older servers',
  );
  assert.match(migration, /actual_index\.relam = expected_index\.relam/u);
  for (const field of ['indkey', 'indclass', 'indcollation', 'indoption', 'indexprs', 'indpred']) {
    assert.match(migration, new RegExp(`actual\\.${field}[\\s\\S]*?expected\\.${field}`, 'u'));
  }
  assert.equal(
    occurrences(migration, /RAISE EXCEPTION 'PostgreSQL approval migration drift:/gu),
    3,
    'column, CHECK, and index drift must each fail closed',
  );
});

test('0004 remains a forward-only approval scope migration', () => {
  const migration = readMigration('0004_pending_approvals_user_scope.sql');

  assert.match(migration, /BEGIN;/u);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS user_id TEXT/u);
  assert.match(migration, /pending_approvals_pending_scope_check/u);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS pending_approvals_tenant_user_pending/u);
  assert.match(migration, /COMMIT;/u);
  assert.doesNotMatch(migration, /DROP COLUMN/iu);
});

test('fresh PostgreSQL schemas reach pending approval scope through the forward migration', () => {
  const migration = readMigration('0001_init.sql');
  const pendingApprovalTable = migration.match(
    /CREATE TABLE IF NOT EXISTS pending_approvals \([\s\S]*?\n\);/u,
  )?.[0];

  assert.ok(pendingApprovalTable);
  assert.doesNotMatch(pendingApprovalTable, /\buser_id\b/u);
  assert.doesNotMatch(pendingApprovalTable, /pending_approvals_pending_scope_check/u);
});
