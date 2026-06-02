// 联网搜索工具 web.search(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:为模型提供「发现 URL」的能力(WebFetch 只能抓已知 URL)。默认零配置零密钥的
//       DDG lite;auto 模式先短超时探 DDG、不可达再回退 Bing(照顾国内网络),也可切 Bing/Tavily。
// 提供商契约:search(query,{maxResults,fetchImpl,lookupImpl}) → { title, url, snippet }[]。
// 依赖:同层 ssrf-guard + search-providers/{ddg,bing} 解析器。导出:webSearch。
//
// web.search — a search-engine wrapper for "research" tasks.
//
// The model has WebFetch (give me a URL, I'll fetch it) but no way to discover
// URLs in the first place — so "search AI news" can't work without this.
// MVP defaults to DuckDuckGo's lite HTML endpoint (zero config, zero key,
// reasonable Chinese coverage). Settings can later swap the provider to Bing
// or Tavily via apiKey + baseUrl, but the default has to JUST WORK out of the
// box for users without any API key.
//
// Provider contract:
//   async function search(query, { maxResults, fetchImpl, lookupImpl }) -> Result[]
// where Result = { title, url, snippet }
import { assertPublicHost } from './ssrf-guard.js';
import { parseDdgLiteResults } from './search-providers/ddg.js';
import { parseBingResults } from './search-providers/bing.js';
import { parseWebSearchOptions } from './web-tool-inputs.js';
import { omitUndefined } from '../util/object.js';
import type { WebSearchError, WebSearchFetchLike, WebSearchOptions, WebSearchResponseLike } from './web-tool-inputs.js';

export type { WebSearchError, WebSearchFetchLike, WebSearchOptions, WebSearchResponseLike } from './web-tool-inputs.js';

const DEFAULT_TIMEOUT_MS = 12_000;
const DDG_PROBE_TIMEOUT_MS = 5_000; // fail-fast on DDG so the auto-fallback to Bing doesn't make the user wait the full 12s
const DEFAULT_MAX_RESULTS = 8;
const RESULT_HARD_CAP = 20;

export type SearchResult = { title: string; url: string; snippet: string };
export type WebSearchResponse = {
  ok: boolean;
  provider: string;
  query: string;
  results: SearchResult[];
  note?: string;
};

type ProviderArgs = {
  query: string;
  maxResults: number;
  fetchImpl: WebSearchFetchLike;
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
  allowInternal: boolean;
  timeoutMs: number;
};

function fail(message: string, statusCode = 400): WebSearchError {
  const error = new Error(`web.search: ${message}`) as WebSearchError;
  error.statusCode = statusCode;
  return error;
}

function safeMaxResults(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(1, Math.floor(n)), RESULT_HARD_CAP);
}

/**
 * 按所选提供商执行搜索(ddg/bing/auto/其他),返回归一化结果列表;query 与 maxResults 先做安全裁剪。
 * Run a search against the chosen provider. Returns a normalized result list.
 */
export async function webSearch(options: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const parsed = parseWebSearchOptions(options);
  const query = parsed.query;
  const maxResults = safeMaxResults(parsed.maxResults);
  const providerName = parsed.provider;
  const fetchImpl = parsed.fetchImpl || globalThis.fetch as unknown as WebSearchFetchLike;
  if (typeof fetchImpl !== 'function') {
    throw fail('no fetch implementation available', 500);
  }

  const baseArgs: ProviderArgs = omitUndefined({
    query,
    maxResults,
    fetchImpl,
    lookupImpl: parsed.lookupImpl,
    allowInternal: parsed.allowInternal === true,
    timeoutMs: parsed.timeoutMs || DEFAULT_TIMEOUT_MS,
  });

  if (providerName === 'ddg') return searchViaDdg(baseArgs);
  if (providerName === 'bing') return searchViaBing(baseArgs);

  if (providerName === 'auto') {
    // Try DDG with a short timeout first (DDG often connect-times-out from
    // mainland China — wait 5s max, not the full 12s, before falling back).
    try {
      const ddg = await searchViaDdg({ ...baseArgs, timeoutMs: DDG_PROBE_TIMEOUT_MS });
      if (ddg.ok && ddg.results.length > 0) return ddg;
    } catch {
      // DDG unreachable — fall through to Bing.
    }
    return searchViaBing(baseArgs);
  }

  // Tavily / other paid providers stubbed — they require an API key from
  // Settings and will land in a follow-up commit.
  return {
    ok: false,
    provider: providerName,
    query,
    results: [],
    note: `provider '${providerName}' is not configured yet — use 'auto' (default), 'ddg' or 'bing', or set up Tavily in Settings.`,
  };
}

/**
 * 经 DuckDuckGo lite 端点搜索(精简 HTML,易解析);对搜索主机本身做 SSRF 校验。
 */
async function searchViaDdg({ query, maxResults, fetchImpl, lookupImpl, allowInternal, timeoutMs }: ProviderArgs): Promise<WebSearchResponse> {
  // lite endpoint returns a strip-down HTML that's far easier to parse than the
  // standard SERP page. Stable enough for MVP; if it ever changes we'll get a
  // visible "0 results" instead of a silent crash.
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  if (!allowInternal) {
    // Best-effort SSRF check on the search host itself (lite.duckduckgo.com).
    // The fetched RESULT urls are returned to the caller untouched — it's up
    // to whoever fetches them next to re-check.
    await assertPublicHost(url.hostname, omitUndefined({ lookupImpl }));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: WebSearchResponseLike | undefined;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        // DDG lite returns plain HTML for text-mode clients; using a real
        // browser UA also avoids occasional empty-body responses.
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err as { name?: string }).name === 'AbortError') {
      throw fail(`search request timed out after ${timeoutMs}ms`, 504);
    }
    throw fail(`search request failed: ${String((err as Error).message || err)}`, 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response) {
    throw fail('search request failed: empty response', 502);
  }
  if (!response.ok) {
    throw fail(`search returned HTTP ${response.status}`, 502);
  }
  const html = await response.text();
  const results = parseDdgLiteResults(html, maxResults);
  return {
    ok: true,
    provider: 'ddg',
    query,
    results,
    ...(results.length ? {} : { note: 'No results parsed from DDG response (page layout may have changed).' }),
  };
}

/**
 * 经 Bing HTML 结果页搜索——给无法访问 DDG(如国内网络)的用户兜底;公开、免密钥。
 * Bing HTML SERP — practical fallback for users who can't reach DDG
 * (mainland China etc.). Public, key-free, mostly stable HTML.
 */
async function searchViaBing({ query, maxResults, fetchImpl, lookupImpl, allowInternal, timeoutMs }: ProviderArgs): Promise<WebSearchResponse> {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults * 2, 20)));
  if (!allowInternal) {
    await assertPublicHost(url.hostname, omitUndefined({ lookupImpl }));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: WebSearchResponseLike | undefined;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err && (err as { name?: string }).name === 'AbortError') {
      throw fail(`bing search timed out after ${timeoutMs}ms`, 504);
    }
    throw fail(`bing search request failed: ${String((err as Error).message || err)}`, 502);
  } finally {
    clearTimeout(timeout);
  }
  if (!response) {
    throw fail('bing search request failed: empty response', 502);
  }
  if (!response.ok) {
    throw fail(`bing returned HTTP ${response.status}`, 502);
  }
  const html = await response.text();
  const results = parseBingResults(html, maxResults);
  return {
    ok: true,
    provider: 'bing',
    query,
    results,
    ...(results.length ? {} : { note: 'No results parsed from Bing response (page layout may have changed).' }),
  };
}
