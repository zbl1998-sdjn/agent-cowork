import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDdgLiteResults, unwrapDdgRedirect } from '../src/tools/search-providers/ddg.js';
import { webSearch } from '../src/tools/web-search.js';

const FIXTURE_DDG_LITE = `
<html><body>
<table>
  <tr><td class="result-link"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.anthropic.com%2Fnews%2Fclaude-4&rut=abc">Anthropic releases Claude 4 — capabilities update</a></td></tr>
  <tr><td class="result-snippet">Anthropic announced Claude 4 with improved long-context reasoning &amp; lower hallucination rates.</td></tr>
  <tr><td class="link-text">www.anthropic.com</td></tr>

  <tr><td class="result-link"><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.moonshot.cn%2Fkimi-k2&rut=def">Kimi K2 上线:更强中文推理能力</a></td></tr>
  <tr><td class="result-snippet">Moonshot AI 发布 Kimi K2,在中文推理任务上提升 18%。</td></tr>
</table>
</body></html>
`;

test('unwrapDdgRedirect extracts underlying URL from /l/?uddg= redirect', () => {
  const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=trash';
  assert.equal(unwrapDdgRedirect(wrapped), 'https://example.com/page');
});

test('unwrapDdgRedirect passes plain URLs through', () => {
  assert.equal(unwrapDdgRedirect('https://example.com/p'), 'https://example.com/p');
});

test('parseDdgLiteResults returns title/url/snippet trio per anchor', () => {
  const results = parseDdgLiteResults(FIXTURE_DDG_LITE, 8);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.anthropic.com/news/claude-4');
  assert.match(results[0].title, /Claude 4/);
  assert.match(results[0].snippet, /long-context/);
  assert.equal(results[1].url, 'https://blog.moonshot.cn/kimi-k2');
  assert.match(results[1].title, /Kimi K2/);
  assert.match(results[1].snippet, /18%/);
});

test('parseDdgLiteResults clamps to limit', () => {
  const big = FIXTURE_DDG_LITE + FIXTURE_DDG_LITE + FIXTURE_DDG_LITE;
  const results = parseDdgLiteResults(big, 3);
  assert.equal(results.length, 3);
});

test('parseDdgLiteResults returns [] for empty / malformed HTML (not crash)', () => {
  assert.deepEqual(parseDdgLiteResults('', 8), []);
  assert.deepEqual(parseDdgLiteResults('<html><body>nothing here</body></html>', 8), []);
});

test('webSearch rejects empty / overlong queries', async () => {
  await assert.rejects(() => webSearch({ query: '' }), /query is required/);
  await assert.rejects(() => webSearch({ query: 'x'.repeat(401) }), /query too long/);
});

test('webSearch via DDG returns normalized results using injected fetch', async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => FIXTURE_DDG_LITE,
  });
  const fakeLookup = async () => '8.8.8.8'; // bypass SSRF guard with a public-looking IP
  const out = await webSearch({
    query: '最新 AI 新闻 2026',
    fetchImpl: /** @type {any} */ (fakeFetch),
    lookupImpl: fakeLookup,
    maxResults: 5,
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'ddg');
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].url, 'https://www.anthropic.com/news/claude-4');
});

test('webSearch returns ok:false + note for unconfigured providers (bing/tavily)', async () => {
  const out = await webSearch({ query: 'test', provider: 'bing' });
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'bing');
  assert.equal(out.results.length, 0);
  assert.match(out.note || '', /not configured/);
});

test('webSearch surfaces HTTP errors as 502 with provider context', async () => {
  const fakeFetch = async () => ({ ok: false, status: 503, text: async () => 'svc down' });
  const fakeLookup = async () => '8.8.8.8';
  await assert.rejects(
    () => webSearch({
      query: 'q',
      fetchImpl: /** @type {any} */ (fakeFetch),
      lookupImpl: fakeLookup,
    }),
    /HTTP 503/,
  );
});
