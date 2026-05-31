// 用户存储与会话(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:桌面登录的本地用户库 + 会话。密码用 scrypt 加盐哈希;会话是映射到用户/租户的不透明 bearer token。
//       本模块含内存适配器(createUserStore,默认/测试用)与共享的凭据/身份助手;SQLite 持久化适配器在
//       sqlite-user-store.js,两者暴露「同一接口」(端口与适配器),哈希/校验逻辑共用以保证一致。
// 依赖:node:crypto。导出:createUserStore + newUserRecord/passwordMatches/newGuestIdentity/newSessionToken 等。
import crypto from 'node:crypto';

export type AuthError = Error & { statusCode?: number };
export type UserRecord = {
  username: string;
  userId: string;
  tenantId: string;
  salt: string;
  hash: string;
  guest?: boolean;
};
export type Identity = {
  username: string;
  userId: string;
  tenantId: string;
  guest?: boolean;
};
export type SessionIdentity = Identity & { token: string };
export type UserStore = {
  register(username: unknown, password: unknown): Identity;
  verify(username: unknown, password: unknown): Identity | null;
  login(username: unknown, password: unknown): SessionIdentity;
  createSession(identity: Identity): string;
  resolveToken(token: unknown): Identity | null;
  logout(token: unknown): boolean;
  createGuest(): SessionIdentity;
  count(): number;
};

// Local user store + sessions for desktop login. Passwords are salted and
// hashed with scrypt; sessions are opaque bearer tokens mapped to a
// user/tenant. This module ships two interchangeable adapters that expose the
// SAME interface (ports & adapters):
//   - createUserStore()        — in-memory (default for tests / ephemeral hosts)
//   - createSqliteUserStore()  — persisted across restarts (see ./sqlite-user-store.js)
// The data layer is already tenant/user-scoped, so login just decides which
// identity a request runs as. Shared credential/identity helpers live here so
// both adapters hash and validate identically.

const USERNAME_RE = /^[a-z0-9_.-]{3,40}$/;

/** scrypt(password, salt) -> hex. Both adapters must share this to keep parity. */
export function hashPassword(password: unknown, salt: string): string {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

/** Normalise + validate a username. Throws a 4xx-tagged Error on failure. */
export function normaliseUsername(username: unknown): string {
  const name = String(username || '').trim().toLowerCase();
  if (!name || !USERNAME_RE.test(name)) {
    const err = new Error('username must be 3-40 chars [a-z0-9_.-]') as AuthError;
    err.statusCode = 400;
    throw err;
  }
  return name;
}

/** Validate a password length policy. Throws a 4xx-tagged Error on failure. */
export function assertValidPassword(password: unknown): void {
  if (!password || String(password).length < 6) {
    const err = new Error('password must be at least 6 characters') as AuthError;
    err.statusCode = 400;
    throw err;
  }
}

/** Mint a fresh user identity (ids + salt + hash) for a registration. */
export function newUserRecord(username: unknown, password: unknown): UserRecord {
  const name = normaliseUsername(username);
  assertValidPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const userId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tenantId = `tenant_${userId.slice(5)}`;
  return { username: name, userId, tenantId, salt, hash: hashPassword(password, salt) };
}

/** Constant-time comparison of a candidate password against a stored record. */
export function passwordMatches(record: { salt: string; hash: string } | null | undefined, password: unknown): boolean {
  if (!record) return false;
  const candidate = hashPassword(password, record.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Mint an anonymous guest identity (isolated tenant). */
export function newGuestIdentity(): Identity {
  const userId = `guest_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return { username: userId, userId, tenantId: `tenant_${userId}`, guest: true };
}

/** Opaque bearer session token. */
export function newSessionToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function createUserStore(): UserStore {
  const users = new Map<string, UserRecord>();    // username -> { username, userId, tenantId, salt, hash }
  const sessions = new Map<string, Identity>(); // token -> { userId, tenantId, username }

  function register(username: unknown, password: unknown): Identity {
    const record = newUserRecord(username, password);
    if (users.has(record.username)) {
      const err = new Error('username already exists') as AuthError;
      err.statusCode = 409;
      throw err;
    }
    users.set(record.username, record);
    return { username: record.username, userId: record.userId, tenantId: record.tenantId };
  }

  function verify(username: unknown, password: unknown): Identity | null {
    const user = users.get(String(username || '').trim().toLowerCase());
    if (!user || !passwordMatches(user, password)) return null;
    return { username: user.username, userId: user.userId, tenantId: user.tenantId };
  }

  function createSession(identity: Identity): string {
    const token = newSessionToken();
    sessions.set(token, {
      userId: identity.userId,
      tenantId: identity.tenantId,
      username: identity.username,
      guest: Boolean(identity.guest),
    });
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
    return sessions.get(String(token || '')) || null;
  }

  function logout(token: unknown): boolean {
    return sessions.delete(String(token || ''));
  }

  // Anonymous local guest: mints an isolated identity + session so the desktop's
  // "skip login" path still passes the auth gate (and gets its own tenant, so
  // guest data never mixes with a registered user's). No credentials required —
  // this is acceptable only because the host is loopback-only + CORS-restricted.
  function createGuest(): SessionIdentity {
    const identity = newGuestIdentity();
    return { ...identity, token: createSession(identity) };
  }

  return { register, verify, login, createSession, resolveToken, logout, createGuest, count: () => users.size };
}
