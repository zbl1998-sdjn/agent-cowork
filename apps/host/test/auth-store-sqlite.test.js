import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSqliteUserStore } from '../src/auth/sqlite-user-store.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-authdb-'));
  return path.join(dir, 'auth.sqlite');
}

test('sqlite user store: register/verify/session parity with in-memory', () => {
  const dbPath = tmpDb();
  const store = createSqliteUserStore({ dbPath });
  const id = store.register('derrick', 'secret123');
  assert.match(id.userId, /^user_/);
  assert.match(id.tenantId, /^tenant_/);
  assert.equal(store.verify('derrick', 'secret123').userId, id.userId);
  assert.equal(store.verify('derrick', 'wrong'), null);
  assert.equal(store.count(), 1);

  const token = store.createSession(id);
  assert.equal(store.resolveToken(token).userId, id.userId);
  assert.equal(store.logout(token), true);
  assert.equal(store.resolveToken(token), null);

  assert.throws(() => store.register('derrick', 'another1'), (e) => e.statusCode === 409);
  assert.throws(() => store.register('x', 'short'), (e) => e.statusCode === 400);
  store.close();
});

test('sqlite user store: users + sessions survive a restart (reopen same db)', () => {
  const dbPath = tmpDb();

  const first = createSqliteUserStore({ dbPath });
  const reg = first.register('alice', 'hunter2x');
  const sessionToken = first.createSession(reg);
  const guest = first.createGuest();
  first.close();

  // Simulate a host restart: brand new store instance over the same file.
  const second = createSqliteUserStore({ dbPath });
  // Registered user still verifiable, and re-registration is blocked.
  assert.equal(second.verify('alice', 'hunter2x').userId, reg.userId);
  assert.throws(() => second.register('alice', 'whatever1'), (e) => e.statusCode === 409);
  // Old session token still resolves to the same identity.
  const resolved = second.resolveToken(sessionToken);
  assert.equal(resolved.userId, reg.userId);
  assert.equal(resolved.tenantId, reg.tenantId);
  // Guest session + isolated tenant also persisted.
  const g = second.resolveToken(guest.token);
  assert.equal(g.userId, guest.userId);
  assert.equal(g.guest, true);
  assert.equal(second.count(), 1); // guests are not persisted as users
  second.close();
});

test('sqlite user store: falls back to in-memory when db cannot be opened', () => {
  // Make the parent path a FILE, so mkdir of the db directory fails (ENOTDIR);
  // the store must still return a working (in-memory) implementation.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-authdb-bad-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const dbPath = path.join(blocker, 'auth.sqlite'); // parent is a file → open throws

  const store = createSqliteUserStore({ dbPath });
  const id = store.register('bob', 'passw0rd');
  assert.equal(store.verify('bob', 'passw0rd').userId, id.userId);
});
