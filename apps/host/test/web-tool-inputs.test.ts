import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebBuiltinTools } from '../src/tools/web-builtin-tools.js';
import { parseWebFetchOptions, parseWebSearchOptions } from '../src/tools/web-tool-inputs.js';
import type { WebFetchLike } from '../src/tools/web-tool-inputs.js';

test('web tool input parsing accepts only declared boundary options', () => {
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
  const lookupImpl = async () => '8.8.8.8';

  assert.deepEqual(parseWebFetchOptions({
    url: 'https://example.com',
    timeoutMs: 1000,
    maxBytes: 128,
    allowInternal: false,
    fetchImpl,
    lookupImpl,
  }), {
    url: 'https://example.com',
    timeoutMs: 1000,
    maxBytes: 128,
    allowInternal: false,
    fetchImpl,
    lookupImpl,
  });

  assert.deepEqual(parseWebSearchOptions({
    query: '  current docs  ',
    maxResults: 3,
    allowInternal: false,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '' }),
    lookupImpl,
    timeoutMs: 2000,
  }).query, 'current docs');
});

test('web tool input parsing rejects malformed options before network access', () => {
  assert.throws(
    () => parseWebFetchOptions({ url: 'https://example.com', fetchImpl: 'not-a-function' as unknown as WebFetchLike }),
    (error: unknown) => error instanceof Error
      && /web\.fetch: fetchImpl: must be a function/.test(error.message)
      && (error as { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => parseWebSearchOptions({ query: '', provider: 'ddg' }),
    (error: unknown) => error instanceof Error
      && /web\.search: query: query is required/.test(error.message)
      && (error as { statusCode?: number }).statusCode === 400,
  );
  assert.throws(
    () => parseWebSearchOptions({ query: 'x'.repeat(401), timeoutMs: -1 }),
    /query too long|timeoutMs/,
  );
});

test('web builtin tools expose approval metadata', () => {
  const tools = createWebBuiltinTools({ now: new Date('2026-06-19T00:00:00.000Z') });
  const fetchTool = tools.find((tool) => tool.name === 'web.fetch');
  const searchTool = tools.find((tool) => tool.name === 'WebSearch');

  assert.ok(fetchTool);
  assert.equal(fetchTool.risk, 'high');
  assert.equal(fetchTool.requiresApproval, true);
  assert.ok(searchTool);
  assert.equal(searchTool.risk, 'low');
  assert.equal(searchTool.mutating, false);
  assert.match(searchTool.description, /2026 年 6 月/);
});

test('web builtin schemas and handlers reject model-controlled hidden arguments', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-web-hidden-arg-'));
  let fetchCalls = 0;
  const tools = createWebBuiltinTools({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, headers: { get: () => 'text/plain' }, arrayBuffer: () => new ArrayBuffer(0) };
    }) as WebFetchLike,
    resolveSecurityMode: () => 'local_strict',
  });
  const fetchTool = tools.find((tool) => tool.name === 'web.fetch');
  const searchTool = tools.find((tool) => tool.name === 'WebSearch');
  assert.ok(fetchTool && searchTool);
  assert.equal(fetchTool.inputSchema?.additionalProperties, false);
  assert.equal(searchTool.inputSchema?.additionalProperties, false);

  await assert.rejects(
    () => fetchTool.handler({ url: 'http://127.0.0.1/private', allowInternal: true }, { trustedRoot }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 400
      && /allowInternal is not allowed/.test(String((error as Error).message)),
  );
  await assert.rejects(
    () => searchTool.handler({ query: 'docs', trustedRoot }, { trustedRoot }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 400
      && /trustedRoot is a protected boundary property/.test(String((error as Error).message)),
  );
  assert.equal(fetchCalls, 0);
});

test('web.fetch and WebSearch honor air_gap/local_strict egress policy (security regression: this was the third bypass instance in the same class)', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-web-egress-'));
  let fetchCalled = false;
  const fetchImpl: WebFetchLike = async () => { fetchCalled = true; return { ok: true, status: 200, headers: { get: () => 'text/plain' }, arrayBuffer: () => new ArrayBuffer(0) }; };

  const airGapTools = createWebBuiltinTools({ fetchImpl, resolveSecurityMode: () => 'air_gap' });
  const airGapFetch = airGapTools.find((tool) => tool.name === 'web.fetch');
  const airGapSearch = airGapTools.find((tool) => tool.name === 'WebSearch');
  assert.ok(airGapFetch && airGapSearch);

  fetchCalled = false;
  await assert.rejects(() => airGapFetch.handler({ url: 'https://example.com' }, { trustedRoot }));
  assert.equal(fetchCalled, false, 'air_gap 下 web.fetch 不得实际发起请求');

  // WebSearch 的出站检查在 webSearch() 实现细节之前就抛错,不需要 mock 真实的搜索实现。
  await assert.rejects(() => airGapSearch.handler({ query: 'test' }, { trustedRoot }));

  const strictTools = createWebBuiltinTools({ fetchImpl, resolveSecurityMode: () => 'local_strict' });
  const strictFetch = strictTools.find((tool) => tool.name === 'web.fetch');
  assert.ok(strictFetch);
  fetchCalled = false;
  await assert.rejects(() => strictFetch.handler({ url: 'https://example.com' }, { trustedRoot }));
  assert.equal(fetchCalled, false, 'local_strict 下 web.fetch 不得实际发起请求');

  // controlled_hybrid 必须停在 needs_approval；当前 handler 没有可消费的、带作用域/
  // 有效期/单次使用语义的审批回执，不能把 needs_approval 当 allow 继续出网。
  const hybridTools = createWebBuiltinTools({ fetchImpl, resolveSecurityMode: () => 'controlled_hybrid' });
  const hybridFetch = hybridTools.find((tool) => tool.name === 'web.fetch');
  const hybridSearch = hybridTools.find((tool) => tool.name === 'WebSearch');
  assert.ok(hybridFetch && hybridSearch);
  fetchCalled = false;
  await assert.rejects(
    () => hybridFetch.handler({ url: 'https://example.com' }, { trustedRoot }),
    (err: unknown) => (err as { code?: string }).code === 'EGRESS_APPROVAL_REQUIRED',
  );
  assert.equal(fetchCalled, false, 'controlled_hybrid 未收到审批回执时 web.fetch 不得出网');

  await assert.rejects(
    () => hybridSearch.handler({ query: 'current docs' }, { trustedRoot }),
    (err: unknown) => (err as { code?: string }).code === 'EGRESS_APPROVAL_REQUIRED',
  );
  assert.equal(fetchCalled, false, 'controlled_hybrid 未收到审批回执时 WebSearch 不得出网');
});
