// Bing 结果页解析器(host · L1 领域层 · tools/search-providers)
// ---------------------------------------------------------------------------
// 职责:把 Bing SERP 的 HTML(li.b_algo 区块)解析成 { title, url, snippet }[]。
//       Bing 是国内默认兜底(DDG 常连不通)。纯函数、确定性;布局不匹配返回 []。
// 依赖:无。导出:parseBingResults。
// 解析策略:逐个 b_algo 区块取首个链接作为标题/URL,再取 b_caption 摘要;不匹配时返回空列表。

const ALGO_BLOCK_RE = /<li[^>]*\bclass=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
const FIRST_ANCHOR_RE = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;
const CAPTION_RE = /<div[^>]*\bclass=["'][^"']*\bb_caption\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

export type ParsedResult = { title: string; url: string; snippet: string };

/**
 * 去标签、解码常见 HTML 实体并折叠空白。
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
 * 从 Bing SERP 提取至多 limit 条结果(逐 b_algo 区块取首链 + b_caption 摘要)。
 */
export function parseBingResults(html: unknown, limit = 8): ParsedResult[] {
  if (typeof html !== 'string' || !html) return [];
  const safeLimit = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));
  const results: ParsedResult[] = [];
  for (const block of html.matchAll(ALGO_BLOCK_RE)) {
    const blockHtml = block[1];
    if (!blockHtml) continue;
    const anchorMatch = FIRST_ANCHOR_RE.exec(blockHtml);
    if (!anchorMatch) continue;
    const url = anchorMatch[1] ?? '';
    const title = clean(anchorMatch[2] ?? '');
    if (!url || !title) continue;
    if (!/^https?:\/\//i.test(url)) continue;
    const captionMatch = CAPTION_RE.exec(blockHtml);
    const snippet = captionMatch ? clean(captionMatch[1] ?? '') : '';
    results.push({ title, url, snippet });
    if (results.length >= safeLimit) break;
  }
  return results;
}
