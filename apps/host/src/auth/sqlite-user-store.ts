// SQLite 用户存储(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:与 createUserStore() 接口完全一致的「持久化」适配器——把注册用户、会话、访客租户存进 SQLite,
//       使已登录用户(或带本地数据的访客)在 host 重启后仍在。表在自有 DB 句柄上幂等创建。
// 依赖:storage/sqlite + 同层 user-store(复用哈希/身份助手)。导出:createSqliteUserStore。
import { openSqliteDatabase } from '../storage/sqlite.js';
import {
  newUserRecord,
  passwordMatches,
  newGuestIdentity,
  newSessionToken,
  DEFAULT_GUEST_SESSION_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  normaliseSessionTtlMs,
} from './user-store.js';
import type { AuthError, Identity, SessionIdentity, UserStore } from './user-store.js';

type AuthRow = {
  username: string;
  user_id: string;
  tenant_id: string;
  salt: string;
  hash: string;
  is_guest?: number;
  expires_at?: string | null;
  n?: number;
};
type AuthStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number };
};
type AuthDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): AuthStatement;
  close?: () => unknown;
};
type SqliteUserStoreOptions = {
  dbPath?: string;
  sessionTtlMs?: unknown;
  guestSessionTtlMs?: unknown;
  now?: () => number;
};

// 本适配器与 createUserStore() 暴露完全相同接口,但把注册用户、会话和访客租户持久化到 SQLite。
// 表使用独立 DB 句柄幂等创建,不耦合 state.sqlite 的迁移顺序。
// 持久化身份库初始化失败必须阻止启动:切换到空内存库会制造一套新的身份边界。

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
    created_at TEXT NOT NULL,
    expires_at TEXT
  );
`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialiseAuthDatabase(dbPath: string | undefined): AuthDatabase {
  let db: AuthDatabase | undefined;
  try {
    db = openSqliteDatabase(dbPath as string) as AuthDatabase;
    db.exec(SCHEMA);
    const sessionColumns = db.prepare('PRAGMA table_info(auth_sessions)').all() as Array<{ name?: string }>;
    if (!sessionColumns.some((column) => column.name === 'expires_at')) {
      db.exec('ALTER TABLE auth_sessions ADD COLUMN expires_at TEXT');
    }
    return db;
  } catch (error) {
    if (db?.close) {
      try {
        db.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          `Persistent SQLite auth store initialization and cleanup failed: ${errorMessage(error)}`,
        );
      }
    }
    throw new Error(
      `Persistent SQLite auth store initialization failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function createSqliteUserStore({
  dbPath,
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  guestSessionTtlMs = DEFAULT_GUEST_SESSION_TTL_MS,
  now = Date.now,
}: SqliteUserStoreOptions = {}): UserStore & { close?: () => void } {
  const db = initialiseAuthDatabase(dbPath);
  const userTtlMs = normaliseSessionTtlMs(sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  const guestTtlMs = normaliseSessionTtlMs(guestSessionTtlMs, DEFAULT_GUEST_SESSION_TTL_MS);

  const insertUser = db.prepare(
    'INSERT INTO auth_users (username, user_id, tenant_id, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectUser = db.prepare('SELECT * FROM auth_users WHERE username = ?');
  const countUsers = db.prepare('SELECT COUNT(*) AS n FROM auth_users');
  const insertSession = db.prepare(
    'INSERT INTO auth_sessions (token, user_id, tenant_id, username, is_guest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    const createdAtMs = now();
    insertSession.run(
      token,
      identity.userId,
      identity.tenantId,
      identity.username,
      identity.guest ? 1 : 0,
      new Date(createdAtMs).toISOString(),
      new Date(createdAtMs + (identity.guest ? guestTtlMs : userTtlMs)).toISOString(),
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
    const normalized = String(token || '');
    const row = selectSession.get(normalized) as AuthRow | undefined;
    if (!row) return null;
    const expiresAt = Date.parse(String(row.expires_at || ''));
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
      deleteSession.run(normalized);
      return null;
    }
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
      if (db.close) db.close();
    },
  };
}
