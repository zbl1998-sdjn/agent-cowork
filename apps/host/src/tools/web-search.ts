// 联网搜索工具 web.search(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:为模型提供「发现 URL」的能力(WebFetch 只能抓已知 URL)。默认零配置零密钥的
//       DDG lite;auto 模式先短超时探 DDG、不可达再回退 Bing(照顾国内网络),也可切 Bing/Tavily。
// 提供商契约:search(query,{maxResults,fetchImpl,lookupImpl}) → { title, url, snippet }[]。
// 依赖:同层 ssrf-guard + search-providers/{ddg,bing} 解析器。导出:webSearch。
import { assertPublicHost } from './ssrf-guard.js';
import { parseDdgLiteResults } from './search-providers/ddg.js';
import { parseBingResults } from './search-providers/bing.js';
import { parseWebSearchOptions } from './web-tool-inputs.js';
import { omitUndefined } from '../util/object.js';
import type { WebSearchError, WebSearchFetchLike, WebSearchOptions, WebSearchResponseLike } from './web-tool-inputs.js';

export type { WebSearchError, WebSearchFetchLike, WebSearchOptions, WebSearchResponseLike } from './web-tool-inputs.js';

const DEFAULT_TIMEOUT_MS = 12_000;
const DDG_PROBE_TIMEOUT_MS = 5_000; // DDG 探测快失败,auto 回退 Bing 时避免让用户等满 12 秒。
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
    // auto 先用短超时试 DDG;国内网络经常连不上,5 秒后回退 Bing。
    try {
      const ddg = await searchViaDdg({ ...baseArgs, timeoutMs: DDG_PROBE_TIMEOUT_MS });
      if (ddg.ok && ddg.results.length > 0) return ddg;
    } catch {
      // DDG 不可达则继续走 Bing 兜底。
    }
    return searchViaBing(baseArgs);
  }

  // Tavily 等付费提供商需要 Settings 中的 API key,当前先显式返回未配置。
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
  // lite 端点返回精简 HTML,比标准 SERP 更容易解析;版式变化时会显式得到 0 结果而不是静默崩溃。
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  if (!allowInternal) {
    // 对搜索主机本身做 SSRF 校验;返回的结果 URL 不在此处抓取,后续 fetch 时会再校验。
    await assertPublicHost(url.hostname, omitUndefined({ lookupImpl }));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: WebSearchResponseLike | undefined;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        // DDG lite 面向文本客户端返回 HTML;真实浏览器 UA 还能减少偶发空响应。
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
