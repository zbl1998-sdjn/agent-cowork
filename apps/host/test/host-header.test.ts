import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRequestMiddleware } from '../src/http/middleware/common.js';
import type {
  MiddlewareRequest,
  MiddlewareResponse,
  RequestContext,
} from '../src/http/middleware/common.js';

type CapturedResponse = MiddlewareResponse & {
  statusCode: number;
  headers: Record<string, string | number>;
  ended: boolean;
  body: string;
};

function makeResponse(): CapturedResponse {
  const res: CapturedResponse = {
    statusCode: 0,
    headers: {},
    ended: false,
    body: '',
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers) {
      res.statusCode = statusCode;
      Object.assign(res.headers, headers ?? {});
    },
    end(chunk) {
      res.ended = true;
      if (chunk !== undefined) res.body += String(chunk);
    },
  };
  return res;
}

function makeRequest(host: string | null, method = 'GET'): MiddlewareRequest {
  return { method, headers: host == null ? {} : { host }, on() { return undefined; } };
}

const ctx = (): RequestContext => ({
  traceId: 't',
  tenantId: 'tenant_local',
  userId: 'user_local',
  authenticated: true,
});

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
