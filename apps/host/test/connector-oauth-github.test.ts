import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeGitHubDeviceFlow,
  fetchGitHubViewer,
  startGitHubDeviceFlow,
} from '../src/connectors/oauth-github.js';

type FetchCall = {
  url: string;
  init: RequestInit;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(response: Response | ((call: FetchCall) => Response | Promise<Response>)): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init: init || {} };
    calls.push(call);
    return typeof response === 'function' ? response(call) : response;
  };
  return { calls, fetchImpl };
}

function formParams(init: RequestInit): URLSearchParams {
  assert.ok(init.body instanceof URLSearchParams, 'request body should be URLSearchParams');
  return init.body;
}

function headerValue(init: RequestInit, key: string): string {
  const headers = init.headers;
  assert.ok(headers && !Array.isArray(headers) && !(headers instanceof Headers), 'headers should be a plain object');
  return String((headers as Record<string, string>)[key] || '');
}

function statusCode(error: unknown): number | undefined {
  return (error as { statusCode?: number }).statusCode;
}

test('startGitHubDeviceFlow posts normalized scopes and returns safe device metadata', async () => {
  const { calls, fetchImpl } = makeFetch(jsonResponse({
    device_code: 'device-code',
    user_code: 'USER-CODE',
    verification_uri: 'https://github.com/login/device',
  }));

  const result = await startGitHubDeviceFlow({
    clientId: ' client-id ',
    scopes: [' repo ', '', 'read:user'],
    fetchImpl,
    deviceCodeUrl: 'https://example.test/device',
  });

  assert.deepEqual(result, {
    provider: 'github',
    deviceCode: 'device-code',
    userCode: 'USER-CODE',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
    scopes: ['repo', 'read:user'],
  });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://example.test/device');
  assert.equal(call.init.method, 'POST');
  assert.equal(headerValue(call.init, 'accept'), 'application/json');
  assert.equal(headerValue(call.init, 'content-type'), 'application/x-www-form-urlencoded');
  assert.equal(formParams(call.init).get('client_id'), 'client-id');
  assert.equal(formParams(call.init).get('scope'), 'repo read:user');
});

test('startGitHubDeviceFlow fails closed for missing config, HTTP errors, and incomplete responses', async () => {
  const missing = makeFetch(jsonResponse({}));
  await assert.rejects(
    () => startGitHubDeviceFlow({ clientId: ' ', fetchImpl: missing.fetchImpl }),
    (error: unknown) => statusCode(error) === 400 && /client id is required/.test(String((error as Error).message)),
  );
  assert.equal(missing.calls.length, 0);

  const denied = makeFetch(jsonResponse({ error: 'bad_client', error_description: 'No such client' }, 401));
  await assert.rejects(
    () => startGitHubDeviceFlow({ clientId: 'client-id', fetchImpl: denied.fetchImpl }),
    (error: unknown) => statusCode(error) === 401 && /No such client/.test(String((error as Error).message)),
  );

  const upstreamDown = makeFetch(new Response('not-json', { status: 503 }));
  await assert.rejects(
    () => startGitHubDeviceFlow({ clientId: 'client-id', fetchImpl: upstreamDown.fetchImpl }),
    (error: unknown) => statusCode(error) === 502 && /503/.test(String((error as Error).message)),
  );

  const incomplete = makeFetch(jsonResponse({ device_code: 'device-code' }));
  await assert.rejects(
    () => startGitHubDeviceFlow({ clientId: 'client-id', fetchImpl: incomplete.fetchImpl }),
    (error: unknown) => statusCode(error) === 502 && /incomplete response/.test(String((error as Error).message)),
  );
});

test('completeGitHubDeviceFlow handles pending states and connected tokens without exposing client secrets', async () => {
  const pending = makeFetch(jsonResponse({ error: 'authorization_pending' }));
  assert.deepEqual(await completeGitHubDeviceFlow({ clientId: 'client-id', deviceCode: 'device-code', fetchImpl: pending.fetchImpl }), {
    status: 'pending',
    error: 'authorization_pending',
    interval: 5,
  });
  const pendingBody = formParams(pending.calls[0]?.init || {});
  assert.equal(pendingBody.get('client_id'), 'client-id');
  assert.equal(pendingBody.get('device_code'), 'device-code');
  assert.equal(pendingBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');

  const slowDown = makeFetch(jsonResponse({ error: 'slow_down' }));
  assert.deepEqual(await completeGitHubDeviceFlow({ clientId: 'client-id', deviceCode: 'device-code', fetchImpl: slowDown.fetchImpl }), {
    status: 'pending',
    error: 'slow_down',
    interval: 10,
  });

  const connected = makeFetch(jsonResponse({ access_token: 'sample-access-token' }));
  assert.deepEqual(await completeGitHubDeviceFlow({ clientId: 'client-id', deviceCode: 'device-code', fetchImpl: connected.fetchImpl }), {
    status: 'connected',
    accessToken: 'sample-access-token',
    tokenType: 'bearer',
    scope: '',
  });
});

test('completeGitHubDeviceFlow rejects terminal OAuth errors and missing access tokens', async () => {
  const expired = makeFetch(jsonResponse({ error: 'expired_token', error_description: 'Code expired' }));
  await assert.rejects(
    () => completeGitHubDeviceFlow({ clientId: 'client-id', deviceCode: 'device-code', fetchImpl: expired.fetchImpl }),
    (error: unknown) => statusCode(error) === 400 && /Code expired/.test(String((error as Error).message)),
  );

  const noToken = makeFetch(jsonResponse({ scope: 'read:user' }));
  await assert.rejects(
    () => completeGitHubDeviceFlow({ clientId: 'client-id', deviceCode: 'device-code', fetchImpl: noToken.fetchImpl }),
    (error: unknown) => statusCode(error) === 502 && /access token/.test(String((error as Error).message)),
  );
});

test('fetchGitHubViewer sends a bearer token and falls back to a safe login label', async () => {
  const { calls, fetchImpl } = makeFetch(jsonResponse({
    id: 123,
    name: 'Sample User',
    email: null,
  }));

  const viewer = await fetchGitHubViewer({
    accessToken: 'sample-access-token',
    fetchImpl,
    userUrl: 'https://example.test/user',
  });

  assert.deepEqual(viewer, {
    login: 'github-user',
    id: 123,
    name: 'Sample User',
    email: null,
  });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://example.test/user');
  assert.equal(call.init.method, 'GET');
  assert.equal(headerValue(call.init, 'accept'), 'application/vnd.github+json');
  assert.equal(headerValue(call.init, 'authorization'), 'Bearer sample-access-token');
});

test('GitHub OAuth calls carry an abort signal and fail with a bounded timeout', async () => {
  let observedSignal: AbortSignal | null = null;
  const hangingFetch: typeof fetch = async (_input, init) => {
    observedSignal = init?.signal || null;
    return await new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };

  await assert.rejects(
    () => startGitHubDeviceFlow({ clientId: 'client-id', fetchImpl: hangingFetch, timeoutMs: 10 }),
    (error: unknown) => statusCode(error) === 504 && /timed out/i.test(String((error as Error).message)),
  );
  assert.ok(observedSignal, 'fetch receives an AbortSignal');
  assert.equal((observedSignal as AbortSignal).aborted, true);
});

test('fetchGitHubViewer emits only bounded primitive account fields', async () => {
  const marker = 'nested-sensitive-value';
  const { fetchImpl } = makeFetch(jsonResponse({
    login: { token: marker },
    id: { raw: marker },
    name: [marker],
    email: { address: marker },
  }));

  const viewer = await fetchGitHubViewer({
    accessToken: 'sample-access-token',
    fetchImpl,
    userUrl: 'https://example.test/user',
  });

  assert.deepEqual(viewer, {
    login: 'github-user',
    id: null,
    name: null,
    email: null,
  });
  assert.doesNotMatch(JSON.stringify(viewer), new RegExp(marker));
});
