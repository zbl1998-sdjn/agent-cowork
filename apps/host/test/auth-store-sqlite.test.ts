import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteUserStore } from '../src/auth/sqlite-user-store.js';
import type { AuthError, Identity } from '../src/auth/user-store.js';
import { openSqliteDatabase } from '../src/storage/sqlite.js';

type InspectableDatabase = ReturnType<typeof openSqliteDatabase> & { close?: () => void };

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-authdb-'));
  return path.join(dir, 'auth.sqlite');
}

function assertStatusCode(error: unknown, expected: number): true {
  assert.ok(error && typeof error === 'object' && 'statusCode' in error);
  assert.equal((error as AuthError).statusCode, expected);
  return true;
}

function requireIdentity(value: Identity | null, label: string): Identity {
  assert.ok(value, `${label} should resolve`);
  return value;
}

test('sqlite user store: register/verify/session parity with in-memory', () => {
  const dbPath = tmpDb();
  const store = createSqliteUserStore({ dbPath });
  const id = store.register('derrick', 'secret123');
  assert.match(id.userId, /^user_/);
  assert.match(id.tenantId, /^tenant_/);
  assert.equal(requireIdentity(store.verify('derrick', 'secret123'), 'registered user').userId, id.userId);
  assert.equal(store.verify('derrick', 'wrong'), null);
  assert.equal(store.count(), 1);

  const token = store.createSession(id);
  assert.equal(requireIdentity(store.resolveToken(token), 'created session').userId, id.userId);
  assert.equal(store.logout(token), true);
  assert.equal(store.resolveToken(token), null);

  assert.throws(() => store.register('derrick', 'another1'), (error) => assertStatusCode(error, 409));
  assert.throws(() => store.register('x', 'short'), (error) => assertStatusCode(error, 400));
  store.close?.();
});

test('sqlite user store: users + sessions survive a restart (reopen same db)', () => {
  const dbPath = tmpDb();

  const first = createSqliteUserStore({ dbPath });
  const reg = first.register('alice', 'hunter2x');
  const sessionToken = first.createSession(reg);
  const guest = first.createGuest();
  first.close?.();

  // Simulate a host restart: brand new store instance over the same file.
  const second = createSqliteUserStore({ dbPath });
  // Registered user still verifiable, and re-registration is blocked.
  assert.equal(requireIdentity(second.verify('alice', 'hunter2x'), 'reopened user').userId, reg.userId);
  assert.throws(() => second.register('alice', 'whatever1'), (error) => assertStatusCode(error, 409));
  // Old session token still resolves to the same identity.
  const resolved = requireIdentity(second.resolveToken(sessionToken), 'persisted session');
  assert.equal(resolved.userId, reg.userId);
  assert.equal(resolved.tenantId, reg.tenantId);
  // Guest session + isolated tenant also persisted.
  const g = requireIdentity(second.resolveToken(guest.token), 'persisted guest session');
  assert.equal(g.userId, guest.userId);
  assert.equal(g.guest, true);
  assert.equal(second.count(), 1); // guests are not persisted as users
  second.close?.();
});

test('sqlite user store: fails closed when the persistent database cannot be opened', () => {
  // Make the parent path a FILE, so mkdir of the db directory fails (ENOTDIR);
  // persistent-auth startup must fail instead of issuing a fresh in-memory identity.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-authdb-bad-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const dbPath = path.join(blocker, 'auth.sqlite'); // parent is a file → open throws

  assert.throws(
    () => createSqliteUserStore({ dbPath }),
    /persistent SQLite auth store initialization failed/i,
  );
});

test('sqlite user store: fails closed when the session schema cannot be migrated', () => {
  const dbPath = tmpDb();
  const incompatibleDb = openSqliteDatabase(dbPath) as InspectableDatabase;
  incompatibleDb.exec(`
    CREATE VIEW auth_sessions AS
    SELECT 'legacy-token' AS token, 'user_legacy' AS user_id, 'tenant_legacy' AS tenant_id;
  `);
  incompatibleDb.close?.();

  assert.throws(
    () => createSqliteUserStore({ dbPath }),
    /persistent SQLite auth store initialization failed/i,
  );
});

test('sqlite user store: creates expires_at on sessions only and schema setup is idempotent', () => {
  const dbPath = tmpDb();
  createSqliteUserStore({ dbPath }).close?.();
  createSqliteUserStore({ dbPath }).close?.();

  const db = openSqliteDatabase(dbPath) as InspectableDatabase;
  const userColumns = db.prepare('PRAGMA table_info(auth_users)').all() as Array<{ name?: string }>;
  const sessionColumns = db.prepare('PRAGMA table_info(auth_sessions)').all() as Array<{ name?: string }>;
  assert.equal(userColumns.some((column) => column.name === 'expires_at'), false);
  assert.equal(sessionColumns.filter((column) => column.name === 'expires_at').length, 1);
  db.close?.();
});

test('sqlite user store: migrates legacy sessions and revokes null-expiry tokens', () => {
  const dbPath = tmpDb();
  const legacyDb = openSqliteDatabase(dbPath) as InspectableDatabase;
  legacyDb.exec(`
    CREATE TABLE auth_users (
      username TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      username TEXT NOT NULL,
      is_guest INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    INSERT INTO auth_sessions (token, user_id, tenant_id, username, is_guest, created_at)
    VALUES ('legacy-token', 'user_legacy', 'tenant_legacy', 'legacy', 0, '2026-07-09T00:00:00.000Z');
  `);
  legacyDb.close?.();

  const store = createSqliteUserStore({ dbPath });
  assert.equal(store.resolveToken('legacy-token'), null);
  store.close?.();

  const inspected = openSqliteDatabase(dbPath) as InspectableDatabase;
  const migratedColumns = inspected.prepare('PRAGMA table_info(auth_sessions)').all() as Array<{ name?: string }>;
  assert.equal(migratedColumns.filter((column) => column.name === 'expires_at').length, 1);
  const revoked = inspected.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE token = ?')
    .get('legacy-token') as { n?: number };
  assert.equal(Number(revoked.n), 0);
  inspected.close?.();
});

test('sqlite user store expires persisted sessions after the bounded TTL', () => {
  const dbPath = tmpDb();
  let now = Date.parse('2026-07-10T00:00:00.000Z');
  const store = createSqliteUserStore({ dbPath, sessionTtlMs: 1_000, now: () => now });
  const identity = store.register('expiryuser', 'secret123');
  const token = store.createSession(identity);
  assert.equal(requireIdentity(store.resolveToken(token), 'fresh session').userId, identity.userId);
  now += 1_001;
  assert.equal(store.resolveToken(token), null);
  assert.equal(store.logout(token), false, 'expired row is deleted when resolved');
  store.close?.();
});
