// Parser for Bing's HTML search results (https://www.bing.com/search?q=...).
//
// Bing is the practical default for Chinese users — duckduckgo.com is
// frequently unreachable from mainland China (IPv6 / Great-Firewall reasons),
// so DDG fails connect-timeout before its first byte. Bing's SERP HTML is
// stable enough for MVP scraping, no API key required.
//
// Each result is rendered as:
//   <li class="b_algo">
//     <h2><a href="URL">TITLE</a></h2>
//     <div class="b_caption"><p>SNIPPET</p></div>
//   </li>
//
// We extract by finding every <li class="b_algo"> block, then within it the
// first <a href="..."> for the URL/title and the first b_caption <p> for the
// snippet. Pure function, deterministic, easy to test against fixtures.

const ALGO_BLOCK_RE = /<li[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
const FIRST_ANCHOR_RE = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
const CAPTION_RE = /<div[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

/** @typedef {{ title: string, url: string, snippet: string }} ParsedResult */

/**
 * Strip HTML tags + decode common entities + collapse whitespace.
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
 * Extract up to `limit` results from a Bing SERP HTML page. Returns []
 * if the layout doesn't match — callers should treat as "no results"
 * rather than crashing.
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {ParsedResult[]}
 */
export function parseBingResults(html, limit = 8) {
  if (typeof html !== 'string' || !html) return [];
  const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));
  /** @type {ParsedResult[]} */
  const results = [];
  for (const block of html.matchAll(ALGO_BLOCK_RE)) {
    const blockHtml = block[1];
    const anchorMatch = FIRST_ANCHOR_RE.exec(blockHtml);
    if (!anchorMatch) continue;
    const url = anchorMatch[1];
    const title = clean(anchorMatch[2]);
    if (!url || !title) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const captionMatch = CAPTION_RE.exec(blockHtml);
    const snippet = captionMatch ? clean(captionMatch[1]) : '';
    results.push({ title, url, snippet });
    if (results.length >= safeLimit) break;
  }
  return results;
}
