// 联网抓取工具 web.fetch(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:受控地抓取一个 http(s) 网址,返回「限长」文本体(供联网研究)。校验协议、
//       施加超时与字节上限,默认通过 ssrf-guard 拦截内网/回环/私网地址,并对每一跳
//       重定向重新校验(防 302 跳转绕过)。依赖:同层 ssrf-guard。导出:webFetch。
//
// web.fetch — a deliberate outbound HTTP tool for "research" tasks.
//
// Unlike the sandbox (network off by default), this is an explicit networked
// capability: callers ask for a URL and get back a size-capped text body. It
// validates the scheme, enforces a timeout and byte cap, and (by default) blocks
// internal/loopback/private hosts — resolving names to real IPs and re-checking
// every redirect hop so a 302 → internal address can't bypass the guard.
import { assertPublicHost } from './ssrf-guard.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

export type WebFetchError = Error & { statusCode?: number };
export type WebFetchResponse = {
  ok?: boolean;
  status?: number;
  headers?: { get(name: string): string | null } | null;
  arrayBuffer(): Promise<ArrayBuffer> | ArrayBuffer;
};
export type WebFetchLike = (
  input: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<WebFetchResponse> | WebFetchResponse;
export type WebFetchOptions = {
  url?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
  allowInternal?: boolean;
  fetchImpl?: WebFetchLike;
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
};
export type WebFetchResult = {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
};

function fail(message: string, statusCode = 400): WebFetchError {
  const error = new Error(`web.fetch: ${message}`) as WebFetchError;
  error.statusCode = statusCode;
  return error;
}

function parseHttpUrl(value: unknown): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw fail('invalid url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('only http(s) urls are allowed');
  }
  return parsed;
}

/**
 * 抓取一个 http(s) URL:SSRF 校验 → 手动跟随重定向(每跳复校验)→ 读回限长文本体。
 */
export async function webFetch({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  allowInternal = false,
  fetchImpl = globalThis.fetch as unknown as WebFetchLike,
  lookupImpl,
}: WebFetchOptions = {}): Promise<WebFetchResult> {
  if (typeof fetchImpl !== 'function') {
    throw fail('no fetch implementation available', 500);
  }
  let parsed = parseHttpUrl(url);
  if (!allowInternal) {
    await assertPublicHost(parsed.hostname, { lookupImpl });
  }

  const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), 60_000);
  const cap = Math.min(Math.max(Number(maxBytes) || DEFAULT_MAX_BYTES, 1), 4 * 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let response: WebFetchResponse | undefined;
  try {
    // Follow redirects manually so each hop's host is re-validated by the SSRF
    // guard — `redirect: 'follow'` would silently chase a 302 to an internal IP.
    for (let hop = 0; ; hop += 1) {
      response = await fetchImpl(parsed.href, { signal: controller.signal, redirect: 'manual' });
      const status = Number(response.status) || 0;
      const location = status >= 300 && status < 400 && response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('location')
        : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) throw fail('too many redirects', 502);
      const next = (() => {
        try {
          return new URL(location, parsed.href);
        } catch {
          throw fail('invalid redirect location', 502);
        }
      })();
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw fail('redirect to non-http(s) blocked', 502);
      }
      if (!allowInternal) {
        await assertPublicHost(next.hostname, { lookupImpl });
      }
      // Free the redirect response's socket before chasing the next hop.
      if (typeof response.arrayBuffer === 'function') {
        try { await response.arrayBuffer(); } catch { /* ignore */ }
      }
      parsed = next;
    }
  } catch (err) {
    const wfErr = err as WebFetchError;
    if (typeof wfErr.statusCode === 'number') throw wfErr;
    const message = err instanceof Error ? err.message : String(err);
    throw fail(`request failed: ${message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!response) {
    throw fail('request failed: empty response', 502);
  }
  const contentType = (response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('content-type')
    : '') || '';
  const buffer = Buffer.from(await response.arrayBuffer());
  const truncated = buffer.length > cap;
  return {
    ok: Boolean(response.ok),
    status: Number(response.status) || 0,
    url: parsed.href,
    contentType,
    bytes: buffer.length,
    truncated,
    text: buffer.subarray(0, cap).toString('utf8'),
  };
}
