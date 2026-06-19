import assert from 'node:assert/strict';
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

test('web builtin tools expose approval metadata and forward bounded fetch args', async () => {
  const calls: Array<{ url: string; redirect?: 'manual'; hasSignal: boolean }> = [];
  const payload = new Uint8Array([97, 98, 99, 100, 101, 102]);
  const fetchImpl: WebFetchLike = async (url, init) => {
    calls.push({ url, redirect: init.redirect, hasSignal: init.signal instanceof AbortSignal });
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/plain' : null) },
      arrayBuffer: () => payload.buffer.slice(0),
    };
  };
  const tools = createWebBuiltinTools({ fetchImpl, now: new Date('2026-06-19T00:00:00.000Z') });
  const fetchTool = tools.find((tool) => tool.name === 'web.fetch');
  const searchTool = tools.find((tool) => tool.name === 'WebSearch');

  assert.ok(fetchTool);
  assert.equal(fetchTool.risk, 'high');
  assert.equal(fetchTool.requiresApproval, true);
  assert.ok(searchTool);
  assert.equal(searchTool.risk, 'low');
  assert.equal(searchTool.mutating, false);
  assert.match(searchTool.description, /2026 年 6 月/);

  const result = await fetchTool.handler({
    url: 'https://example.com/page',
    timeoutMs: 50,
    maxBytes: 4,
    allowInternal: true,
  }) as { ok: boolean; status: number; url: string; contentType: string; bytes: number; truncated: boolean; text: string };
  assert.deepEqual(result, {
    ok: true,
    status: 200,
    url: 'https://example.com/page',
    contentType: 'text/plain',
    bytes: 6,
    truncated: true,
    text: 'abcd',
  });
  assert.deepEqual(calls, [{ url: 'https://example.com/page', redirect: 'manual', hasSignal: true }]);
});
