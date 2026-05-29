// Parser for https://lite.duckduckgo.com/lite/ HTML.
//
// The lite endpoint returns a table-based layout (a deliberate "text-mode"
// view DDG keeps stable for screen readers / scrapers). Each result is a
// 4-row block:
//
//   <tr><td class="result-link"><a rel="nofollow" href="URL">TITLE</a></td></tr>
//   <tr><td class="result-snippet">SNIPPET</td></tr>
//   <tr><td class="link-text">URL TEXT</td></tr>
//   <tr><!-- spacer --></tr>
//
// We extract by walking <a rel="nofollow" href="..."> anchors anywhere in the
// page and matching them to the following <td class="result-snippet"> using
// regex. Pure function, deterministic, easy to test against captured fixtures.

const ANCHOR_RE = /<a\b[^>]*\brel=["']?nofollow["']?[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SNIPPET_RE = /<td[^>]*class=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

/** @typedef {{ title: string, url: string, snippet: string }} ParsedResult */

/**
 * Strip HTML tags + collapse whitespace + decode common entities. Kept
 * minimal — DDG lite escapes &amp; / &quot; / &#39; / &lt; / &gt; and
 * nothing else interesting.
 *
 * @param {string} raw
 * @returns {string}
 */
function clean(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(TAG_RE, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

/**
 * Unwrap DuckDuckGo's tracking redirect (e.g.
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
 * ) back into the underlying target URL. If the URL isn't a DDG redirect,
 * returns the input unchanged.
 *
 * @param {string} href
 * @returns {string}
 */
export function unwrapDdgRedirect(href) {
  if (!href) return '';
  try {
    // Lite uses scheme-less '//duckduckgo.com/l/' — paste a scheme for URL().
    const normalized = href.startsWith('//') ? `https:${href}` : href;
    const url = new URL(normalized);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const uddg = url.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * Extract up to `limit` search results from a DDG lite HTML page. Returns []
 * if the page layout doesn't match (callers should treat that as "no results"
 * not "crashed").
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {ParsedResult[]}
 */
export function parseDdgLiteResults(html, limit = 8) {
  if (typeof html !== 'string' || !html) return [];
  const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));

  /** @type {Array<{ url: string, title: string }>} */
  const anchors = [];
  for (const match of html.matchAll(ANCHOR_RE)) {
    const rawHref = match[1];
    const rawTitle = clean(match[2]);
    if (!rawHref || !rawTitle) continue;
    const url = unwrapDdgRedirect(rawHref);
    // Skip internal DDG navigation that survived (next page, ads, etc.).
    if (url.includes('duckduckgo.com/?')) continue;
    anchors.push({ url, title: rawTitle });
    if (anchors.length >= safeLimit) break;
  }

  /** @type {string[]} */
  const snippets = [];
  for (const match of html.matchAll(SNIPPET_RE)) {
    snippets.push(clean(match[1]));
    if (snippets.length >= anchors.length) break;
  }

  return anchors.map((a, i) => ({ title: a.title, url: a.url, snippet: snippets[i] || '' }));
}
