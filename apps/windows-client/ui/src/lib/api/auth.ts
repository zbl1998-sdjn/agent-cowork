// 鉴权 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:封装注册/登录/访客登录/登出/当前身份查询,成功后落地或清除本地 token(经 transport)。
// 依赖/对应路由:POST /api/auth/register、/api/auth/login、/api/auth/guest、/api/auth/logout、GET /api/auth/me。导出:register / login / guestLogin / getMe / logout + AuthIdentity 类型。
import { getAuthToken, getJson, postJson, resolveUrl, setAuthToken } from './transport';

export interface AuthIdentity {
  userId: string;
  tenantId: string;
  username: string;
}

export async function register(username: string, password: string): Promise<AuthIdentity> {
  const res = await postJson<AuthIdentity & { token: string }>('/api/auth/register', { username, password });
  setAuthToken(res.token);
  return { userId: res.userId, tenantId: res.tenantId, username: res.username };
}

export async function login(username: string, password: string): Promise<AuthIdentity> {
  const res = await postJson<AuthIdentity & { token: string }>('/api/auth/login', { username, password });
  setAuthToken(res.token);
  return { userId: res.userId, tenantId: res.tenantId, username: res.username };
}

export async function guestLogin(): Promise<AuthIdentity | null> {
  try {
    const res = await postJson<AuthIdentity & { token: string }>('/api/auth/guest', {});
    setAuthToken(res.token);
    return { userId: res.userId, tenantId: res.tenantId, username: res.username };
  } catch {
    return null;
  }
}

/** 与 guestLogin 相同,但把失败原因透出给 UI(而不是静默返回 null),便于用户看到真实错误。 */
export async function guestLoginOrThrow(): Promise<AuthIdentity> {
  try {
    const res = await postJson<AuthIdentity & { token: string }>('/api/auth/guest', {});
    setAuthToken(res.token);
    return { userId: res.userId, tenantId: res.tenantId, username: res.username };
  } catch (err) {
    // 诊断:把当前页面 origin 与解析出的 host 基址一并带出,便于定位跨源/PNA/CSP 拦截。
    const origin = typeof window !== 'undefined' ? window.location.href : '(no window)';
    const base = resolveUrl('/api/auth/guest');
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${reason} [from=${origin} to=${base}]`);
  }
}

export async function getMe(): Promise<AuthIdentity | null> {
  if (!getAuthToken()) return null;
  try {
    const res = await getJson<AuthIdentity>('/api/auth/me');
    return { userId: res.userId, tenantId: res.tenantId, username: res.username };
  } catch {
    setAuthToken(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await postJson('/api/auth/logout', {});
  } catch {
    /* 登出尽力而为;无论远端是否成功都清理本地 token */
  }
  setAuthToken(null);
}
