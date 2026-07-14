// ONLYOFFICE 配置(host · L1 artifacts)
// ---------------------------------------------------------------------------
// 职责:集中解析 Document Server、回调基址、JWT 与有界网络参数；不向客户端暴露 secret。
import { readCompatEnv } from '../util/env-compat.js';

export type OnlyOfficeConfigInput = Readonly<{
  enabled?: boolean;
  documentServerUrl?: string;
  publicBaseUrl?: string;
  jwtSecret?: string;
  jwtHeader?: string;
  sessionTtlMs?: number;
  fetchTimeoutMs?: number;
  maxFileBytes?: number;
}>;

export type OnlyOfficeConfig = Readonly<{
  enabled: boolean;
  configured: boolean;
  documentServerUrl: string;
  publicBaseUrl: string;
  publicHost: string;
  jwtSecret: string;
  jwtHeader: string;
  sessionTtlMs: number;
  fetchTimeoutMs: number;
  maxFileBytes: number;
  missing: readonly string[];
}>;

function booleanValue(value: unknown): boolean {
  return value === true || /^(1|true|yes|on)$/iu.test(String(value || ''));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? Math.floor(parsed) : fallback;
}

function serviceUrl(value: unknown, label: string, originOnly = false): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be an absolute HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an absolute HTTP(S) URL without credentials, query or fragment`);
  }
  if (originOnly && parsed.pathname !== '/') throw new Error(`${label} must not contain a path`);
  return parsed.toString().replace(/\/$/u, '');
}

export function resolveOnlyOfficeConfig(
  input: OnlyOfficeConfigInput = {},
  env: Record<string, string | undefined> = process.env,
): OnlyOfficeConfig {
  const enabled = input.enabled ?? booleanValue(readCompatEnv(env, 'ACW_ONLYOFFICE_ENABLED', 'KCW_ONLYOFFICE_ENABLED'));
  const documentServerUrl = serviceUrl(
    input.documentServerUrl ?? readCompatEnv(env, 'ACW_ONLYOFFICE_DOCUMENT_SERVER_URL', 'KCW_ONLYOFFICE_DOCUMENT_SERVER_URL'),
    'ONLYOFFICE documentServerUrl',
  );
  const publicBaseUrl = serviceUrl(
    input.publicBaseUrl ?? readCompatEnv(env, 'ACW_ONLYOFFICE_PUBLIC_BASE_URL', 'KCW_ONLYOFFICE_PUBLIC_BASE_URL'),
    'ONLYOFFICE publicBaseUrl',
    true,
  );
  const jwtSecret = String(input.jwtSecret ?? readCompatEnv(env, 'ACW_ONLYOFFICE_JWT_SECRET', 'KCW_ONLYOFFICE_JWT_SECRET') ?? '');
  const jwtHeader = String(input.jwtHeader ?? readCompatEnv(env, 'ACW_ONLYOFFICE_JWT_HEADER', 'KCW_ONLYOFFICE_JWT_HEADER') ?? 'Authorization').trim();
  if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/u.test(jwtHeader)) throw new Error('ONLYOFFICE jwtHeader is invalid');
  const missing = [
    !documentServerUrl && 'ACW_ONLYOFFICE_DOCUMENT_SERVER_URL',
    !publicBaseUrl && 'ACW_ONLYOFFICE_PUBLIC_BASE_URL',
    jwtSecret.length < 12 && 'ACW_ONLYOFFICE_JWT_SECRET(min 12 chars)',
  ].filter(Boolean) as string[];
  return Object.freeze({
    enabled,
    configured: enabled && missing.length === 0,
    documentServerUrl,
    publicBaseUrl,
    publicHost: publicBaseUrl ? new URL(publicBaseUrl).host : '',
    jwtSecret,
    jwtHeader,
    sessionTtlMs: boundedNumber(input.sessionTtlMs ?? readCompatEnv(env, 'ACW_ONLYOFFICE_SESSION_TTL_MS', 'KCW_ONLYOFFICE_SESSION_TTL_MS'), 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    fetchTimeoutMs: boundedNumber(input.fetchTimeoutMs ?? readCompatEnv(env, 'ACW_ONLYOFFICE_FETCH_TIMEOUT_MS', 'KCW_ONLYOFFICE_FETCH_TIMEOUT_MS'), 15_000, 1_000, 60_000),
    maxFileBytes: boundedNumber(input.maxFileBytes ?? readCompatEnv(env, 'ACW_ONLYOFFICE_MAX_FILE_BYTES', 'KCW_ONLYOFFICE_MAX_FILE_BYTES'), 100 * 1024 * 1024, 1024, 500 * 1024 * 1024),
    missing: Object.freeze(missing),
  });
}
