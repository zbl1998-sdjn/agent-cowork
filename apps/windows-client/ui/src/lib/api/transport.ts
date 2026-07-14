// HTTP 传输层(UI · lib/api 传输层)
// ---------------------------------------------------------------------------
// 职责:前端与 Node host 通信的「唯一底层出口」——解析 host 基址(区分打包态 tauri.localhost / Vite :5173 /
//       挂载在 host 后的同源)、统一 fetch 封装(注入鉴权头、超时、错误归一化)。各域 API 都建立在它之上。
// 依赖:@tauri-apps/api(取外壳信息)。导出:defaultHostBase + 请求封装。
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

export function defaultHostBase(): string {
  if (typeof window !== 'undefined') {
    const { origin, port, protocol, hostname } = window.location;
    // 打包桌面 WebView 来自 tauri.localhost/tauri:,开发态来自 Vite :5173;这些都不是 Node host。
    // 只有页面本身由 host 通过 http(s) 托管时才信任 origin,否则回退 127.0.0.1:3017。
    const servedByTauri = protocol === 'tauri:' || hostname === 'tauri.localhost' || hostname === 'tauri';
    if ((protocol === 'http:' || protocol === 'https:') && port !== '5173' && !servedByTauri) {
      return origin;
    }
  }
  return 'http://127.0.0.1:3017';
}

const HOST_BASE = defaultHostBase();
const AUTH_TOKEN_KEY = 'acw.authToken';
const WORKSPACE_GRANT_KEY = 'acw.workspaceGrantId';
const LEGACY_RECENT_WORKSPACES_KEY = 'acw.recentWorkspaces';
const WORKSPACE_GRANT_ID_PATTERN = /^grant_[A-Za-z0-9-]{1,72}$/;

export function resolveUrl(route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  return `${HOST_BASE}${route.startsWith('/') ? '' : '/'}${route}`;
}

// withGlobalTauri:false 下没有 window.__TAURI__,桌面检测要看 Tauri 2 internals 通道。
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new Error(`Tauri command "${command}" is unavailable outside the desktop shell`);
  }
  return tauriInvoke<T>(command, args);
}

export interface DesktopHostStatus {
  url: string;
  running: boolean;
  verified: boolean;
}

function isVerifiedDesktopStatus(value: unknown): value is DesktopHostStatus {
  const status = value as Partial<DesktopHostStatus> | null;
  return Boolean(status && status.running === true && status.verified === true && typeof status.url === 'string');
}

async function desktopHostStatus(): Promise<DesktopHostStatus> {
  return invokeDesktop<DesktopHostStatus>('host_status');
}

async function probeHealth(): Promise<boolean> {
  try {
    const response = await fetch(resolveUrl('/health'));
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureHost(attempts = 40, intervalMs = 250): Promise<boolean> {
  if (isDesktop()) {
    try {
      const started = await invokeDesktop<DesktopHostStatus>('start_node_host');
      if (isVerifiedDesktopStatus(started)) return true;
    } catch {
      // setup 可能已启动 host；继续只向 native 层查询身份校验状态。
    }
    for (let i = 0; i < attempts; i += 1) {
      try {
        if (isVerifiedDesktopStatus(await desktopHostStatus())) return true;
      } catch {
        // native 状态暂不可用时继续有限次轮询，不回退信任 loopback /health。
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  for (let i = 0; i < attempts; i += 1) {
    if (await probeHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export const hostReady: Promise<boolean> = ensureHost().catch(() => false);

/** 每次敏感请求前动态确认 desktop host 仍由本次 Tauri 启动且已通过 native HMAC 校验。 */
export async function requireHost(): Promise<void> {
  if (isDesktop()) {
    try {
      if (isVerifiedDesktopStatus(await desktopHostStatus())) return;
    } catch {
      // 进入下面的有限次重新启动/校验路径。
    }
    if (await ensureHost()) return;
    throw new Error('desktop host identity is not verified');
  }
  if (!(await hostReady)) throw new Error('host is unavailable');
}

function readStoredToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(AUTH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

let authToken: string | null = readStoredToken();

function readStoredWorkspaceGrantId(): string | null {
  try {
    // One-time privacy migration: previous builds persisted raw workspace paths.
    globalThis.localStorage?.removeItem(LEGACY_RECENT_WORKSPACES_KEY);
    const value = globalThis.localStorage?.getItem(WORKSPACE_GRANT_KEY) || null;
    if (value && WORKSPACE_GRANT_ID_PATTERN.test(value)) return value;
    if (value) globalThis.localStorage?.removeItem(WORKSPACE_GRANT_KEY);
    return null;
  } catch {
    return null;
  }
}

let workspaceGrantId: string | null = readStoredWorkspaceGrantId();

export function getAuthToken(): string | null {
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token && token.trim() ? token.trim() : null;
  try {
    if (authToken) globalThis.localStorage?.setItem(AUTH_TOKEN_KEY, authToken);
    else globalThis.localStorage?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* 测试/SSR 下 storage 可能不可用,此时仅保留内存 token */
  }
}

export function getWorkspaceGrantId(): string | null {
  return workspaceGrantId;
}

export function setWorkspaceGrantId(grantId: string | null): void {
  if (grantId !== null && !WORKSPACE_GRANT_ID_PATTERN.test(grantId)) {
    throw new Error('invalid workspace grant id');
  }
  workspaceGrantId = grantId;
  try {
    if (workspaceGrantId) globalThis.localStorage?.setItem(WORKSPACE_GRANT_KEY, workspaceGrantId);
    else globalThis.localStorage?.removeItem(WORKSPACE_GRANT_KEY);
    globalThis.localStorage?.removeItem(LEGACY_RECENT_WORKSPACES_KEY);
  } catch {
    /* 测试/SSR 下 storage 可能不可用,此时仅保留内存 grant id */
  }
}

export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const headers = { ...base };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  if (workspaceGrantId) headers['x-workspace-grant-id'] = workspaceGrantId;
  return headers;
}

async function parse<T>(response: Response, route: string): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error((payload as { error?: string }).error || `${route} returned ${response.status}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return payload as T;
}

export async function getJson<T>(route: string): Promise<T> {
  await requireHost();
  return parse<T>(await fetch(resolveUrl(route), { headers: authHeaders() }), route);
}

export interface PostBody {
  idempotencyKey?: string;
  [key: string]: unknown;
}

export async function postJson<T>(route: string, body: PostBody): Promise<T> {
  await requireHost();
  const headers: Record<string, string> = authHeaders({ 'content-type': 'application/json' });
  if (body.idempotencyKey) headers['idempotency-key'] = body.idempotencyKey;
  const response = await fetch(resolveUrl(route), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return parse<T>(response, route);
}

export async function sendJsonMethod<T>(method: string, route: string, body?: unknown): Promise<T> {
  await requireHost();
  const headers = authHeaders({ 'content-type': 'application/json' });
  if (body && typeof body === 'object' && 'idempotencyKey' in body) {
    const value = (body as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof value === 'string' && value) headers['idempotency-key'] = value;
  }
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(resolveUrl(route), init);
  return parse<T>(response, route);
}

export async function openPath(path: string): Promise<boolean> {
  if (isDesktop()) {
    await invokeDesktop('open_path', { path });
    return true;
  }
  return false;
}

export function newIdempotencyKey(prefix = 'acw'): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}
