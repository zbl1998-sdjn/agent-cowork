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
export type UserStoreOptions = {
  sessionTtlMs?: unknown;
  guestSessionTtlMs?: unknown;
  now?: () => number;
};
type SessionRecord = { identity: Identity; expiresAt: number };

// 登录层只决定请求以哪个 tenant/user 身份运行;下游数据层已经按该身份隔离。
// 这里保留内存与 SQLite 两个可互换适配器,并集中哈希/校验助手以保证行为一致。

const USERNAME_RE = /^[a-z0-9_.-]{3,40}$/;
export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GUEST_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function normaliseSessionTtlMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(30 * 24 * 60 * 60 * 1000, Math.max(1_000, Math.floor(parsed)));
}

/** 用 scrypt(password,salt) 生成十六进制哈希;两个适配器必须共用以保持兼容。 */
export function hashPassword(password: unknown, salt: string): string {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

/** 规整并校验用户名;失败时抛带 4xx statusCode 的错误。 */
export function normaliseUsername(username: unknown): string {
  const name = String(username || '').trim().toLowerCase();
  if (!name || !USERNAME_RE.test(name)) {
    const err = new Error('username must be 3-40 chars [a-z0-9_.-]') as AuthError;
    err.statusCode = 400;
    throw err;
  }
  return name;
}

/** 校验密码长度策略;失败时抛带 4xx statusCode 的错误。 */
export function assertValidPassword(password: unknown): void {
  if (!password || String(password).length < 6) {
    const err = new Error('password must be at least 6 characters') as AuthError;
    err.statusCode = 400;
    throw err;
  }
}

/** 为注册请求生成新用户记录(id、salt、hash)。 */
export function newUserRecord(username: unknown, password: unknown): UserRecord {
  const name = normaliseUsername(username);
  assertValidPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  const userId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const tenantId = `tenant_${userId.slice(5)}`;
  return { username: name, userId, tenantId, salt, hash: hashPassword(password, salt) };
}

/** 用恒定时间比较候选密码与存储哈希,避免时序侧信道。 */
export function passwordMatches(record: { salt: string; hash: string } | null | undefined, password: unknown): boolean {
  if (!record) return false;
  const candidate = hashPassword(password, record.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 生成匿名访客身份,并为其分配独立 tenant。 */
export function newGuestIdentity(): Identity {
  const userId = `guest_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  return { username: userId, userId, tenantId: `tenant_${userId}`, guest: true };
}

/** 生成不透明 bearer 会话 token。 */
export function newSessionToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function createUserStore({
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  guestSessionTtlMs = DEFAULT_GUEST_SESSION_TTL_MS,
  now = Date.now,
}: UserStoreOptions = {}): UserStore {
  const users = new Map<string, UserRecord>();    // username -> { username, userId, tenantId, salt, hash }
  const sessions = new Map<string, SessionRecord>();
  const userTtlMs = normaliseSessionTtlMs(sessionTtlMs, DEFAULT_SESSION_TTL_MS);
  const guestTtlMs = normaliseSessionTtlMs(guestSessionTtlMs, DEFAULT_GUEST_SESSION_TTL_MS);

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
    const sessionIdentity = {
      userId: identity.userId,
      tenantId: identity.tenantId,
      username: identity.username,
      guest: Boolean(identity.guest),
    };
    sessions.set(token, {
      identity: sessionIdentity,
      expiresAt: now() + (identity.guest ? guestTtlMs : userTtlMs),
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
    const normalized = String(token || '');
    const session = sessions.get(normalized);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(normalized);
      return null;
    }
    return session.identity;
  }

  function logout(token: unknown): boolean {
    return sessions.delete(String(token || ''));
  }

  // 本地访客用于「跳过登录」:仍然签发隔离身份和会话,让鉴权门保持开启且不混入注册用户数据。
  // 免凭据只在 host 限回环 + CORS 受限的桌面场景下可接受。
  function createGuest(): SessionIdentity {
    const identity = newGuestIdentity();
    return { ...identity, token: createSession(identity) };
  }

  return { register, verify, login, createSession, resolveToken, logout, createGuest, count: () => users.size };
}
