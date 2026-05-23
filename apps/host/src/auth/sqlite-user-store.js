import { openSqliteDatabase } from '../storage/sqlite.js';
import {
  createUserStore,
  newUserRecord,
  passwordMatches,
  newGuestIdentity,
  newSessionToken,
} from './user-store.js';

// SQLite-backed user store. Mirrors createUserStore()'s interface exactly, but
// persists registered users + sessions + guest tenants across host restarts so
// a signed-in user (or a guest with local data) survives a relaunch.
//
// Tables are created idempotently on its own DB handle (no migration ordering
// coupling with state.sqlite). If node:sqlite is unavailable or the DB can't be
// opened, we degrade gracefully to the in-memory store — login still works for
// the session, it just won't persist (matching the prior behaviour rather than
// hard-failing the whole host).

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_users (
    username   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    tenant_id  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    tenant_id  TEXT NOT NULL,
    username   TEXT NOT NULL,
    is_guest   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`;

export function createSqliteUserStore({ dbPath } = {}) {
  let db;
  try {
    db = openSqliteDatabase(dbPath);
    db.exec(SCHEMA);
  } catch (err) {
    // Graceful degradation: keep the host usable even without persistence.
    console.error('[auth] sqlite user store unavailable, falling back to in-memory:', err && err.message);
    return createUserStore();
  }

  const insertUser = db.prepare(
    'INSERT INTO auth_users (username, user_id, tenant_id, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectUser = db.prepare('SELECT * FROM auth_users WHERE username = ?');
  const countUsers = db.prepare('SELECT COUNT(*) AS n FROM auth_users');
  const insertSession = db.prepare(
    'INSERT INTO auth_sessions (token, user_id, tenant_id, username, is_guest, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectSession = db.prepare('SELECT * FROM auth_sessions WHERE token = ?');
  const deleteSession = db.prepare('DELETE FROM auth_sessions WHERE token = ?');

  function register(username, password) {
    const record = newUserRecord(username, password);
    if (selectUser.get(record.username)) {
      const err = new Error('username already exists');
      err.statusCode = 409;
      throw err;
    }
    insertUser.run(record.username, record.userId, record.tenantId, record.salt, record.hash, new Date().toISOString());
    return { username: record.username, userId: record.userId, tenantId: record.tenantId };
  }

  function verify(username, password) {
    const row = selectUser.get(String(username || '').trim().toLowerCase());
    if (!row) return null;
    const record = { salt: row.salt, hash: row.hash };
    if (!passwordMatches(record, password)) return null;
    return { username: row.username, userId: row.user_id, tenantId: row.tenant_id };
  }

  function createSession(identity) {
    const token = newSessionToken();
    insertSession.run(
      token,
      identity.userId,
      identity.tenantId,
      identity.username,
      identity.guest ? 1 : 0,
      new Date().toISOString(),
    );
    return token;
  }

  function login(username, password) {
    const identity = verify(username, password);
    if (!identity) {
      const err = new Error('invalid username or password');
      err.statusCode = 401;
      throw err;
    }
    return { ...identity, token: createSession(identity) };
  }

  function resolveToken(token) {
    const row = selectSession.get(String(token || ''));
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id, username: row.username, guest: row.is_guest === 1 };
  }

  function logout(token) {
    const res = deleteSession.run(String(token || ''));
    return Boolean(res && res.changes);
  }

  function createGuest() {
    const identity = newGuestIdentity();
    return { ...identity, token: createSession(identity) };
  }

  return {
    register,
    verify,
    login,
    createSession,
    resolveToken,
    logout,
    createGuest,
    count: () => {
      const row = countUsers.get();
      return row ? Number(row.n) : 0;
    },
    close: () => {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
