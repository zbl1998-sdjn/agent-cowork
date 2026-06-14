// 联网抓取工具 web.fetch(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:受控地抓取一个 http(s) 网址,返回「限长」文本体(供联网研究)。校验协议、
//       施加超时与字节上限,默认通过 ssrf-guard 拦截内网/回环/私网地址,并对每一跳
//       重定向重新校验(防 302 跳转绕过)。依赖:同层 ssrf-guard。导出:webFetch。
import { assertPublicHost } from './ssrf-guard.js';
import { parseWebFetchOptions } from './web-tool-inputs.js';
import { omitUndefined } from '../util/object.js';
import type { WebFetchError, WebFetchLike, WebFetchOptions, WebFetchResponse } from './web-tool-inputs.js';

export type { WebFetchError, WebFetchLike, WebFetchOptions } from './web-tool-inputs.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;

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
export async function webFetch(options: WebFetchOptions = {}): Promise<WebFetchResult> {
  const {
    url,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    allowInternal = false,
    fetchImpl = globalThis.fetch as unknown as WebFetchLike,
    lookupImpl,
  } = parseWebFetchOptions(options);
  if (typeof fetchImpl !== 'function') {
    throw fail('no fetch implementation available', 500);
  }
  let parsed = parseHttpUrl(url);
  if (!allowInternal) {
    await assertPublicHost(parsed.hostname, omitUndefined({ lookupImpl }));
  }

  const budget = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1), 60_000);
  const cap = Math.min(Math.max(Number(maxBytes) || DEFAULT_MAX_BYTES, 1), 4 * 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  let response: WebFetchResponse | undefined;
  try {
    // 手动跟随重定向,确保每一跳都重新过 SSRF 校验;redirect:follow 会静默追到内网地址。
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
        await assertPublicHost(next.hostname, omitUndefined({ lookupImpl }));
      }
      // 追下一跳前释放当前重定向响应的 socket。
      if (typeof response.arrayBuffer === 'function') {
        try { await response.arrayBuffer(); } catch { /* body 读取失败时仍按 HTTP 错误返回 */ }
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
