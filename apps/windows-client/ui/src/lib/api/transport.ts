import { invoke as tauriInvoke } from '@tauri-apps/api/core';

function defaultHostBase(): string {
  if (typeof window !== 'undefined') {
    const { origin, port, protocol } = window.location;
    if ((protocol === 'http:' || protocol === 'https:') && port !== '5173') return origin;
  }
  return 'http://127.0.0.1:3017';
}

const HOST_BASE = defaultHostBase();
const AUTH_TOKEN_KEY = 'kcw.authToken';

export function resolveUrl(route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  return `${HOST_BASE}${route.startsWith('/') ? '' : '/'}${route}`;
}

// We ship with withGlobalTauri:false, so desktop detection uses the Tauri 2
// internals channel that @tauri-apps/api talks to instead of window.__TAURI__.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new Error(`Tauri command "${command}" is unavailable outside the desktop shell`);
  }
  return tauriInvoke<T>(command, args);
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
    void invokeDesktop('start_node_host').catch(() => { /* host autostarted in setup; probe decides */ });
  }
  for (let i = 0; i < attempts; i += 1) {
    if (await probeHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export const hostReady: Promise<boolean> = ensureHost().catch(() => false);

function readStoredToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(AUTH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

let authToken: string | null = readStoredToken();

export function getAuthToken(): string | null {
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token && token.trim() ? token.trim() : null;
  try {
    if (authToken) globalThis.localStorage?.setItem(AUTH_TOKEN_KEY, authToken);
    else globalThis.localStorage?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* storage unavailable (tests/SSR) -> in-memory only */
  }
}

export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...base, authorization: `Bearer ${authToken}` } : { ...base };
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
  await hostReady;
  return parse<T>(await fetch(resolveUrl(route), { headers: authHeaders() }), route);
}

export interface PostBody {
  idempotencyKey?: string;
  [key: string]: unknown;
}

export async function postJson<T>(route: string, body: PostBody): Promise<T> {
  await hostReady;
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
  await hostReady;
  const headers = authHeaders({ 'content-type': 'application/json' });
  if (body && typeof body === 'object' && 'idempotencyKey' in body) {
    const value = (body as { idempotencyKey?: unknown }).idempotencyKey;
    if (typeof value === 'string' && value) headers['idempotency-key'] = value;
  }
  const response = await fetch(resolveUrl(route), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(response, route);
}

export async function openPath(path: string): Promise<boolean> {
  if (isDesktop()) {
    await invokeDesktop('open_path', { path });
    return true;
  }
  return false;
}

export function newIdempotencyKey(prefix = 'kcw'): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${rand}`;
}
