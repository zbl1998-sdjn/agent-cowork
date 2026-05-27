import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRequestMiddleware } from '../src/http/middleware/common.js';

function makeResponse() {
  const res = { statusCode: 0, headers: {}, ended: false, body: '' };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers || {}); };
  res.end = (chunk) => { res.ended = true; if (chunk) res.body += String(chunk); };
  return res;
}

function makeRequest(host, method = 'GET') {
  return { method, headers: host == null ? {} : { host }, on() {} };
}

const ctx = () => ({ traceId: 't', tenantId: 'tenant_local', userId: 'user_local', authenticated: true });

test('rejects a non-loopback Host header (DNS rebinding)', () => {
  const response = makeResponse();
  const handled = applyRequestMiddleware({
    request: makeRequest('evil.com:3001'),
    response,
    pathname: '/api/conversations',
    requestContext: ctx(),
    validateHost: true,
  });
  assert.equal(handled, true);
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /Host not allowed/);
});

test('allows loopback and tauri webview Host headers', () => {
  for (const host of ['127.0.0.1:3001', 'localhost:3001', '[::1]:3001', 'tauri.localhost']) {
    const response = makeResponse();
    const handled = applyRequestMiddleware({
      request: makeRequest(host),
      response,
      pathname: '/healthz',
      requestContext: ctx(),
      validateHost: true,
    });
    assert.equal(handled, false, `${host} should pass the Host check`);
  }
});

test('missing Host header is allowed (non-browser client)', () => {
  const response = makeResponse();
  const handled = applyRequestMiddleware({
    request: makeRequest(null),
    response,
    pathname: '/healthz',
    requestContext: ctx(),
    validateHost: true,
  });
  assert.equal(handled, false);
});

test('validateHost:false disables the Host allowlist', () => {
  const response = makeResponse();
  const handled = applyRequestMiddleware({
    request: makeRequest('evil.com'),
    response,
    pathname: '/healthz',
    requestContext: ctx(),
    validateHost: false,
  });
  assert.equal(handled, false);
});
