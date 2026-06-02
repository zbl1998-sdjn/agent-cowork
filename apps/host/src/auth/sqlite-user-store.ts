// SQLite 用户存储(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:与 createUserStore() 接口完全一致的「持久化」适配器——把注册用户、会话、访客租户存进 SQLite,
//       使已登录用户(或带本地数据的访客)在 host 重启后仍在。表在自有 DB 句柄上幂等创建。
// 依赖:storage/sqlite + 同层 user-store(复用哈希/身份助手)。导出:createSqliteUserStore。
import { openSqliteDatabase } from '../storage/sqlite.js';
import {
  createUserStore,
  newUserRecord,
  passwordMatches,
  newGuestIdentity,
  newSessionToken,
} from './user-store.js';
import type { AuthError, Identity, SessionIdentity, UserStore } from './user-store.js';

type AuthRow = {
  username: string;
  user_id: string;
  tenant_id: string;
  salt: string;
  hash: string;
  is_guest?: number;
  n?: number;
};
type AuthStatement = {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes?: number };
};
type AuthDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): AuthStatement;
  close?: () => unknown;
};
type SqliteUserStoreOptions = { dbPath?: string };

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

export function createSqliteUserStore({ dbPath }: SqliteUserStoreOptions = {}): UserStore & { close?: () => void } {
  let db: AuthDatabase;
  try {
    db = openSqliteDatabase(dbPath as string) as AuthDatabase;
    db.exec(SCHEMA);
  } catch (err) {
    // Graceful degradation: keep the host usable even without persistence.
    const error = (err || {}) as { message?: string };
    console.error('[auth] sqlite user store unavailable, falling back to in-memory:', error.message);
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

  function register(username: unknown, password: unknown): Identity {
    const record = newUserRecord(username, password);
    if (selectUser.get(record.username)) {
      const err = new Error('username already exists') as AuthError;
      err.statusCode = 409;
      throw err;
    }
    insertUser.run(record.username, record.userId, record.tenantId, record.salt, record.hash, new Date().toISOString());
    return { username: record.username, userId: record.userId, tenantId: record.tenantId };
  }

  function verify(username: unknown, password: unknown): Identity | null {
    const row = selectUser.get(String(username || '').trim().toLowerCase()) as AuthRow | undefined;
    if (!row) return null;
    const record = { salt: row.salt, hash: row.hash };
    if (!passwordMatches(record, password)) return null;
    return { username: row.username, userId: row.user_id, tenantId: row.tenant_id };
  }

  function createSession(identity: Identity): string {
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

  function login(username: unknown, password: unknown): SessionIdentity {
    const identity = verify(username, password);
    if (!identity) {
      const err = new Error('invalid username or password') as AuthError;
      err.statusCode = 401;
      throw err;
    }
    return { ...identity, token: createSession(identity) };
  }

  function resolveToken(token: unknown): Identity | null {
    const row = selectSession.get(String(token || '')) as AuthRow | undefined;
    if (!row) return null;
    return { userId: row.user_id, tenantId: row.tenant_id, username: row.username, guest: row.is_guest === 1 };
  }

  function logout(token: unknown): boolean {
    const res = deleteSession.run(String(token || ''));
    return Boolean(res && res.changes);
  }

  function createGuest(): SessionIdentity {
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
      const row = countUsers.get() as AuthRow | undefined;
      return row ? Number(row.n) : 0;
    },
    close: () => {
      try { if (db.close) db.close(); } catch { /* already closed */ }
    },
  };
}
