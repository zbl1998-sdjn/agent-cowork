// DuckDuckGo lite 结果页解析器(host · L1 领域层 · tools/search-providers)
// ---------------------------------------------------------------------------
// 职责:把 lite.duckduckgo.com 的表格式 HTML 解析成 { title, url, snippet }[]。
//       纯函数、确定性、易用 fixture 测试;布局不匹配时返回 [](视作「无结果」而非崩溃)。
// 依赖:无。导出:unwrapDdgRedirect(还原跳转真链)/ parseDdgLiteResults。
// 解析策略:遍历 rel="nofollow" 的结果链接,再按顺序配对 result-snippet 摘要;布局变化时返回空列表。

const ANCHOR_RE = /<a\b[^>]*\brel=["']?nofollow["']?[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const SNIPPET_RE = /<td[^>]*class=["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

export type ParsedResult = { title: string; url: string; snippet: string };

/**
 * 去标签、折叠空白并解码 DDG lite 常见实体;保持最小实现,避免引入 HTML 解析依赖。
 */
function clean(raw: string): string {
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
 * 把 DDG 的跟踪跳转(//duckduckgo.com/l/?uddg=…)还原成真实目标 URL;非跳转则原样返回。
 */
export function unwrapDdgRedirect(href: unknown): string {
  const rawHref = String(href || '');
  if (!rawHref) return '';
  try {
    // lite 使用无 scheme 的 //duckduckgo.com/l/,URL() 前先补 https。
    const normalized = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
    const url = new URL(normalized);
    if (url.hostname.endsWith('duckduckgo.com') && url.pathname === '/l/') {
      const uddg = url.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return url.toString();
  } catch {
    return rawHref;
  }
}

/**
 * 从 DDG lite 页面提取至多 limit 条结果(锚点配对其后的 result-snippet)。
 */
export function parseDdgLiteResults(html: unknown, limit = 8): ParsedResult[] {
  if (typeof html !== 'string' || !html) return [];
  const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));

  const anchors: Array<{ url: string; title: string }> = [];
  for (const match of html.matchAll(ANCHOR_RE)) {
    const rawHref = match[1] ?? '';
    const rawTitle = clean(match[2] ?? '');
    if (!rawHref || !rawTitle) continue;
    const url = unwrapDdgRedirect(rawHref);
    // 跳过仍残留的 DDG 内部导航(下一页、广告等)。
    if (url.includes('duckduckgo.com/?')) continue;
    anchors.push({ url, title: rawTitle });
    if (anchors.length >= safeLimit) break;
  }

  const snippets: string[] = [];
  for (const match of html.matchAll(SNIPPET_RE)) {
    snippets.push(clean(match[1] ?? ''));
    if (snippets.length >= anchors.length) break;
  }

  return anchors.map((a, i) => ({ title: a.title, url: a.url, snippet: snippets[i] || '' }));
}
