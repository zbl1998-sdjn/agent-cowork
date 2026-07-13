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
    removeHeader(name) {
      Reflect.deleteProperty(res.headers, name.toLowerCase());
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

test('external ONLYOFFICE Host is limited to signed content and callback routes', () => {
  const publicHost = 'host.docker.internal:3017';
  for (const [method, pathname] of [
    ['GET', '/api/artifacts/onlyoffice/content'],
    ['POST', '/api/artifacts/onlyoffice/callback'],
  ] as const) {
    const response = makeResponse();
    const handled = applyRequestMiddleware({
      request: makeRequest(publicHost, method),
      response,
      pathname,
      requestContext: { ...ctx(), authenticated: false },
      requireAuth: true,
      validateHost: true,
      onlyOfficePublicHost: publicHost,
    });
    assert.equal(handled, false, `${method} ${pathname} should reach its signed route guard`);
  }

  for (const [method, pathname] of [
    ['GET', '/api/artifacts/onlyoffice/status'],
    ['POST', '/api/auth/login'],
  ] as const) {
    const response = makeResponse();
    const handled = applyRequestMiddleware({
      request: makeRequest(publicHost, method),
      response,
      pathname,
      requestContext: { ...ctx(), authenticated: false },
      requireAuth: true,
      validateHost: true,
      onlyOfficePublicHost: publicHost,
    });
    assert.equal(handled, true, `${method} ${pathname} must retain the loopback Host boundary`);
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Host not allowed/);
  }
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

test('only the fixed Office web frame may be embedded by the same local origin', () => {
  const frameResponse = makeResponse();
  const handled = applyRequestMiddleware({
    request: makeRequest('127.0.0.1:3017'),
    response: frameResponse,
    pathname: '/office-web-frame.html',
    requestContext: ctx(),
  });
  assert.equal(handled, false);
  assert.equal(frameResponse.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(String(frameResponse.headers['content-security-policy']), /frame-ancestors 'self'/);

  const bridgeResponse = makeResponse();
  applyRequestMiddleware({
    request: makeRequest('127.0.0.1:3017'),
    response: bridgeResponse,
    pathname: '/vendor/office-web-frame.js',
    requestContext: ctx(),
  });
  assert.equal(bridgeResponse.headers['cross-origin-resource-policy'], 'cross-origin');

  const ordinaryResponse = makeResponse();
  applyRequestMiddleware({
    request: makeRequest('127.0.0.1:3017'),
    response: ordinaryResponse,
    pathname: '/',
    requestContext: ctx(),
  });
  assert.equal(ordinaryResponse.headers['x-frame-options'], 'DENY');
  assert.match(String(ordinaryResponse.headers['content-security-policy']), /frame-ancestors 'none'/);

  const onlyOfficeResponse = makeResponse();
  applyRequestMiddleware({
    request: makeRequest('127.0.0.1:3017'),
    response: onlyOfficeResponse,
    pathname: '/onlyoffice-editor.html',
    requestContext: ctx(),
  });
  assert.equal(onlyOfficeResponse.headers['x-frame-options'], undefined);
  assert.match(String(onlyOfficeResponse.headers['content-security-policy']), /frame-ancestors 'none'/);
});
