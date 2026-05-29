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

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 8;
const RESULT_HARD_CAP = 20;

/**
 * @typedef {Error & { statusCode?: number }} WebSearchError
 * @typedef {{ title: string, url: string, snippet: string }} SearchResult
 * @typedef {{ query?: unknown, maxResults?: unknown, provider?: unknown, allowInternal?: boolean, fetchImpl?: typeof globalThis.fetch, lookupImpl?: (host: string) => Promise<unknown> | unknown, timeoutMs?: number }} WebSearchOptions
 * @typedef {{ ok: boolean, provider: string, query: string, results: SearchResult[], note?: string }} WebSearchResponse
 */

/**
 * @param {string} message
 * @param {number} [statusCode]
 * @returns {WebSearchError}
 */
function fail(message, statusCode = 400) {
  const error = /** @type {WebSearchError} */ (new Error(`web.search: ${message}`));
  error.statusCode = statusCode;
  return error;
}

/** @param {unknown} value */
function safeQuery(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw fail('query is required');
  if (text.length > 400) throw fail('query too long (max 400 chars)');
  return text;
}

/** @param {unknown} value */
function safeMaxResults(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.max(1, Math.floor(n)), RESULT_HARD_CAP);
}

/**
 * Run a search against the chosen provider. Returns a normalized result list.
 *
 * @param {WebSearchOptions} [options]
 * @returns {Promise<WebSearchResponse>}
 */
export async function webSearch(options = {}) {
  const query = safeQuery(options.query);
  const maxResults = safeMaxResults(options.maxResults);
  const providerName = typeof options.provider === 'string' && options.provider ? options.provider : 'ddg';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw fail('no fetch implementation available', 500);
  }

  if (providerName === 'ddg') {
    return searchViaDdg({
      query,
      maxResults,
      fetchImpl,
      lookupImpl: options.lookupImpl,
      allowInternal: options.allowInternal === true,
      timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
  }

  // Bing / Tavily / other providers are stubbed — they require an API key
  // from Settings and will land in a follow-up commit. Return an empty list
  // with a clear note so the model can fall back to ddg or tell the user.
  return {
    ok: false,
    provider: providerName,
    query,
    results: [],
    note: `provider '${providerName}' is not configured yet — set search provider to 'ddg' in Settings, or wait for the Bing/Tavily integration.`,
  };
}

/**
 * @param {{ query: string, maxResults: number, fetchImpl: typeof globalThis.fetch, lookupImpl?: (host: string) => Promise<unknown> | unknown, allowInternal: boolean, timeoutMs: number }} args
 * @returns {Promise<WebSearchResponse>}
 */
async function searchViaDdg({ query, maxResults, fetchImpl, lookupImpl, allowInternal, timeoutMs }) {
  // lite endpoint returns a strip-down HTML that's far easier to parse than the
  // standard SERP page. Stable enough for MVP; if it ever changes we'll get a
  // visible "0 results" instead of a silent crash.
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  if (!allowInternal) {
    // Best-effort SSRF check on the search host itself (lite.duckduckgo.com).
    // The fetched RESULT urls are returned to the caller untouched — it's up
    // to whoever fetches them next to re-check.
    await assertPublicHost(url.hostname, { lookupImpl });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
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
    clearTimeout(timeout);
    if (err && /** @type {{ name?: string }} */ (err).name === 'AbortError') {
      throw fail(`search request timed out after ${timeoutMs}ms`, 504);
    }
    throw fail(`search request failed: ${String(/** @type {Error} */ (err).message || err)}`, 502);
  }
  clearTimeout(timeout);
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
