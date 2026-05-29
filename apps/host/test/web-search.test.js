import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDdgLiteResults, unwrapDdgRedirect } from '../src/tools/search-providers/ddg.js';
import { parseBingResults } from '../src/tools/search-providers/bing.js';
import { webSearch } from '../src/tools/web-search.js';

const FIXTURE_BING = `
<html><body>
<ol id="b_results">
  <li class="b_algo">
    <h2><a href="https://www.anthropic.com/news/claude-4">Anthropic releases Claude 4</a></h2>
    <div class="b_caption"><p>Anthropic announced Claude 4 with improved long-context reasoning.</p></div>
  </li>
  <li class="b_algo">
    <h2><a href="https://blog.moonshot.cn/kimi-k2">Kimi K2 上线</a></h2>
    <div class="b_caption"><p>Moonshot AI 发布 Kimi K2,中文推理能力提升 18%。</p></div>
  </li>
  <li class="b_pag"><!-- pagination, skip --></li>
</ol>
</body></html>
`;

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

test('parseBingResults extracts title/url/snippet per b_algo block, skips pagination', () => {
  const results = parseBingResults(FIXTURE_BING, 8);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.anthropic.com/news/claude-4');
  assert.match(results[0].title, /Claude 4/);
  assert.match(results[0].snippet, /long-context/);
  assert.equal(results[1].url, 'https://blog.moonshot.cn/kimi-k2');
  assert.match(results[1].title, /Kimi K2/);
});

test('parseBingResults returns [] for empty / malformed HTML', () => {
  assert.deepEqual(parseBingResults('', 8), []);
  assert.deepEqual(parseBingResults('<html>no algos here</html>', 8), []);
});

test('webSearch via bing returns normalized results using injected fetch', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, text: async () => FIXTURE_BING });
  const out = await webSearch({
    query: 'test',
    provider: 'bing',
    fetchImpl: /** @type {any} */ (fakeFetch),
    lookupImpl: async () => '8.8.8.8',
    maxResults: 5,
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'bing');
  assert.equal(out.results.length, 2);
});

test('webSearch auto provider falls back to bing when DDG fails', async () => {
  let calls = 0;
  const fakeFetch = async (url) => {
    calls += 1;
    if (String(url).includes('duckduckgo')) {
      const err = new Error('connect timeout');
      throw err;
    }
    if (String(url).includes('bing.com')) {
      return { ok: true, status: 200, text: async () => FIXTURE_BING };
    }
    throw new Error('unexpected url ' + url);
  };
  const out = await webSearch({
    query: 'test',
    // omit provider -> defaults to 'auto' via the handler; here we set it explicitly
    provider: 'auto',
    fetchImpl: /** @type {any} */ (fakeFetch),
    lookupImpl: async () => '8.8.8.8',
    maxResults: 5,
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'bing', 'should have fallen back to bing after DDG failed');
  assert.equal(out.results.length, 2);
  assert.ok(calls >= 2, 'expected both DDG attempt and Bing fallback to fire');
});

test('webSearch returns ok:false + note for unknown providers (tavily etc.)', async () => {
  const out = await webSearch({ query: 'test', provider: 'tavily' });
  assert.equal(out.ok, false);
  assert.equal(out.provider, 'tavily');
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
