import { getAuthToken, getJson, postJson, setAuthToken } from './transport';

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
    /* best-effort: clear locally regardless */
  }
  setAuthToken(null);
}
