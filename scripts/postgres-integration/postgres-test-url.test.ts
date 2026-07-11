import assert from 'node:assert/strict';
import test from 'node:test';

import { requireEphemeralPostgresUrl } from './postgres-test-url.js';

test('PostgreSQL integration accepts only an explicit loopback test database', () => {
  for (const connectionString of [
    'postgres://test_user:test_password@localhost:5432/kcw_test',
    'postgresql://test_user:test_password@127.0.0.1:5432/kcw_integration_test',
    'postgres://test_user:test_password@[::1]:5432/test',
  ]) {
    assert.equal(
      requireEphemeralPostgresUrl({ KCW_TEST_POSTGRES_URL: connectionString }),
      connectionString,
    );
  }
});

test('PostgreSQL integration never falls back to DATABASE_URL', () => {
  assert.throws(
    () => requireEphemeralPostgresUrl({
      DATABASE_URL: 'postgres://production_user:production_password@db.example.com/app',
    }),
    /KCW_TEST_POSTGRES_URL is required/u,
  );
});

test('PostgreSQL integration permits the fixed CI service hostname only on GitHub Actions', () => {
  const connectionString = 'postgres://test_user:test_password@postgres:5432/kcw_test';
  assert.equal(
    requireEphemeralPostgresUrl({
      KCW_TEST_POSTGRES_URL: connectionString,
      CI: 'true',
      GITHUB_ACTIONS: 'true',
    }),
    connectionString,
  );
  assert.throws(
    () => requireEphemeralPostgresUrl({ KCW_TEST_POSTGRES_URL: connectionString }),
    /loopback host/u,
  );
});

test('PostgreSQL integration rejects remote, ambiguous, and non-test targets', () => {
  for (const connectionString of [
    'postgres://test_user:test_password@db.example.com:5432/kcw_test',
    'postgres://test_user:test_password@127.0.0.1:5432/postgres',
    'postgres://test_user:test_password@127.0.0.1:5432/testproduction',
    'postgres://test_user:test_password@127.0.0.1:5432/kcw_test?sslmode=disable',
    'postgres://test_user:test_password@127.0.0.1:5432/kcw_test#fragment',
    'https://127.0.0.1/kcw_test',
  ]) {
    assert.throws(
      () => requireEphemeralPostgresUrl({ KCW_TEST_POSTGRES_URL: connectionString }),
      /KCW_TEST_POSTGRES_URL/u,
    );
  }
});
