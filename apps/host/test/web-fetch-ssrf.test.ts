import assert from 'node:assert/strict';
import test from 'node:test';
import { webFetch } from '../src/tools/web-fetch.js';
import type { WebFetchLike } from '../src/tools/web-fetch.js';

type MockWebFetchResponse = Awaited<ReturnType<WebFetchLike>>;

function abuf(s: string): ArrayBuffer {
  return new Uint8Array([...s].map((char) => char.charCodeAt(0))).buffer;
}

function redirectResponse(location: string): MockWebFetchResponse {
  return {
    status: 302,
    ok: false,
    headers: { get: (name: string) => (name === 'location' ? location : null) },
    arrayBuffer: async () => abuf(''),
  };
}

function textResponse(text: string): MockWebFetchResponse {
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => (name === 'content-type' ? 'text/plain' : null) },
    arrayBuffer: async () => abuf(text),
  };
}

test('webFetch blocks the 172.16/12 private range by default', async () => {
  await assert.rejects(() => webFetch({ url: 'http://172.16.5.5/' }), /blocked/);
});

test('webFetch blocks decimal-encoded loopback', async () => {
  await assert.rejects(() => webFetch({ url: 'http://2130706433/' }), /blocked/);
});

test('webFetch blocks a hostname that resolves to an internal IP (no network hit)', async () => {
  const lookupImpl = async (_host: string) => [{ address: '127.0.0.1' }];
  const fetchImpl: WebFetchLike = async () => { throw new Error('should not reach fetch'); };
  await assert.rejects(
    () => webFetch({ url: 'http://rebind.evil.test/', lookupImpl, fetchImpl }),
    /blocked/,
  );
});

test('webFetch re-validates redirect targets and blocks 301 → internal', async () => {
  let calls = 0;
  const fetchImpl: WebFetchLike = async () => {
    calls += 1;
    return {
      status: 301,
      ok: false,
      headers: { get: (name: string) => (name === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
      arrayBuffer: async () => abuf(''),
    };
  };
  // Initial public host resolves public; the redirect target is a literal internal IP.
  const lookupImpl = async (_host: string) => [{ address: '93.184.216.34' }];
  await assert.rejects(
    () => webFetch({ url: 'http://research.example.test/', fetchImpl, lookupImpl }),
    /blocked/,
  );
  assert.equal(calls, 1, 'must stop after the first (redirect) response');
});

test('webFetch follows a public → public redirect and returns the final body', async () => {
  let i = 0;
  const fetchImpl: WebFetchLike = async () => {
    i += 1;
    if (i === 1) {
      return redirectResponse('http://final.example.test/page');
    }
    return textResponse('final body');
  };
  const lookupImpl = async (_host: string) => [{ address: '93.184.216.34' }];
  const out = await webFetch({ url: 'http://start.example.test/', fetchImpl, lookupImpl });
  assert.equal(out.status, 200);
  assert.equal(out.text, 'final body');
  assert.equal(out.url, 'http://final.example.test/page');
});
