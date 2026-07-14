import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveOnlyOfficeConfig } from '../src/artifacts/onlyoffice-config.js';
import { signOnlyOfficeJwt } from '../src/artifacts/onlyoffice-jwt.js';
import { createDocxDocument } from '../src/artifacts/office-writers.js';
import { fetchOnlyOfficeFile, probeOnlyOffice } from '../src/routes/onlyoffice-route-support.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const SECRET = 'sample-onlyoffice-jwt-secret-for-tests';

test('ONLYOFFICE session is approval-bound and callback publishes one owned copy', async () => {
  const trustedRoot = tempRoot('kcw-onlyoffice-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const sourcePath = path.join(artifactRoot, '周报.docx');
  const targetPath = path.join(artifactRoot, 'weekly-full.docx');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const source = createDocxDocument({ title: '周报', paragraphs: ['旧内容'] });
  const edited = createDocxDocument({ title: '周报', paragraphs: ['ONLYOFFICE 新内容'] });
  fs.writeFileSync(sourcePath, source);
  const fetchCalls: string[] = [];
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    onlyOffice: {
      enabled: true,
      documentServerUrl: 'http://127.0.0.1:8082',
      publicBaseUrl: 'http://host.docker.internal:3017',
      jwtSecret: SECRET,
    },
    onlyOfficeFetch: async (input, init) => {
      fetchCalls.push(String(input));
      assert.equal(init?.redirect, 'error');
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(edited, {
        status: 200,
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      });
    },
  });
  const base = await bind(server);
  try {
    const request = {
      trustedRoot,
      path: sourcePath,
      copyName: 'weekly-full.docx',
    };
    const rejected = await jsonRequest(base, '/api/artifacts/onlyoffice/session', {
      method: 'POST',
      headers: { 'idempotency-key': 'onlyoffice-without-approval' },
      body: request,
    });
    assert.equal(rejected.status, 428);

    const preview = await jsonRequest(base, '/api/artifacts/onlyoffice/session/preview', {
      method: 'POST',
      body: request,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const started = await jsonRequest(base, '/api/artifacts/onlyoffice/session', {
      method: 'POST',
      headers: { 'idempotency-key': 'onlyoffice-approved' },
      body: {
        ...request,
        fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
      },
    });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.ok(samePathReal(stringField(started.body, 'path'), targetPath));
    const editorPath = stringField(started.body, 'editorPath');
    const sessionToken = new URL(editorPath, base).searchParams.get('session');
    assert.ok(sessionToken);

    const contentResponse = await fetch(`${base}/api/artifacts/onlyoffice/content?session=${encodeURIComponent(sessionToken)}`);
    assert.equal(contentResponse.status, 200);
    assert.match(contentResponse.headers.get('content-disposition') || '', /filename\*=UTF-8''%E5%91%A8%E6%8A%A5\.docx/);
    assert.deepEqual(Buffer.from(await contentResponse.arrayBuffer()), source);

    const editorResponse = await fetch(`${base}${editorPath}`);
    const editorHtml = await editorResponse.text();
    assert.equal(editorResponse.status, 200);
    assert.match(editorHtml, /web-apps\/apps\/api\/documents\/api\.js/);
    assert.doesNotMatch(editorHtml, new RegExp(SECRET));
    assert.match(editorResponse.headers.get('content-security-policy') || '', /127\.0\.0\.1:8082/);

    const callbackBody = {
      key: stringField(started.body, 'documentKey'),
      status: 2,
      url: 'http://127.0.0.1:8082/cache/files/edited.docx',
      filetype: 'docx',
    };
    const callbackJwt = signOnlyOfficeJwt({ payload: callbackBody }, SECRET);
    const callback = await jsonRequest(
      base,
      `/api/artifacts/onlyoffice/callback?session=${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${callbackJwt}` },
        body: callbackBody,
      },
    );
    assert.equal(callback.status, 200, JSON.stringify(callback.body));
    assert.equal(callback.body.error, 0);
    assert.deepEqual(fs.readFileSync(sourcePath), source, 'source must stay byte-identical');
    assert.deepEqual(fs.readFileSync(targetPath), edited);
    assert.deepEqual(fetchCalls, [callbackBody.url]);

    const replay = await jsonRequest(
      base,
      `/api/artifacts/onlyoffice/callback?session=${encodeURIComponent(sessionToken)}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${callbackJwt}` },
        body: callbackBody,
      },
    );
    assert.equal(replay.body.error, 0, JSON.stringify(replay.body));
  } finally {
    await close(server);
  }
});

test('ONLYOFFICE outbound requests reject redirects before a second request', async () => {
  const config = resolveOnlyOfficeConfig({
    enabled: true,
    documentServerUrl: 'http://127.0.0.1:8082',
    publicBaseUrl: 'http://host.docker.internal:3017',
    jwtSecret: SECRET,
  });
  const privateUrl = 'http://169.254.169.254/latest/meta-data/';
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (url === privateUrl) return new Response('private response');
    if (init?.redirect === 'error') throw new TypeError('fetch failed');
    return fetchImpl(privateUrl);
  };

  const probe = await probeOnlyOffice({ config, fetchImpl });
  assert.deepEqual(probe, { healthy: false, detail: 'unreachable' });
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:8082/healthcheck',
    redirect: 'error',
  }]);

  calls.length = 0;
  const callbackUrl = 'http://127.0.0.1:8082/cache/files/edited.docx';
  await assert.rejects(
    () => fetchOnlyOfficeFile(callbackUrl, { config, fetchImpl }),
    /fetch failed/,
  );
  assert.deepEqual(calls, [{ url: callbackUrl, redirect: 'error' }]);
});

test('ONLYOFFICE callback rejects missing JWT and cross-origin download URLs', async () => {
  const trustedRoot = tempRoot('kcw-onlyoffice-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const sourcePath = path.join(artifactRoot, 'weekly.docx');
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(sourcePath, createDocxDocument({ title: '周报', paragraphs: ['正文'] }));
  let fetched = false;
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: false,
    onlyOffice: {
      enabled: true,
      documentServerUrl: 'http://127.0.0.1:8082',
      publicBaseUrl: 'http://host.docker.internal:3017',
      jwtSecret: SECRET,
    },
    onlyOfficeFetch: async () => {
      fetched = true;
      return new Response('unexpected');
    },
  });
  const base = await bind(server);
  try {
    const request = { trustedRoot, path: sourcePath, copyName: 'weekly-full.docx' };
    const preview = await jsonRequest(base, '/api/artifacts/onlyoffice/session/preview', { method: 'POST', body: request });
    const started = await jsonRequest(base, '/api/artifacts/onlyoffice/session', {
      method: 'POST',
      headers: { 'idempotency-key': 'onlyoffice-security' },
      body: { ...request, fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId') },
    });
    const sessionToken = new URL(stringField(started.body, 'editorPath'), base).searchParams.get('session');
    assert.ok(sessionToken);
    const body = {
      key: stringField(started.body, 'documentKey'),
      status: 2,
      url: 'http://attacker.example/edited.docx',
      filetype: 'docx',
    };
    const noJwt = await jsonRequest(base, `/api/artifacts/onlyoffice/callback?session=${encodeURIComponent(sessionToken)}`, {
      method: 'POST',
      body,
    });
    assert.equal(noJwt.status, 403);
    const badOrigin = await jsonRequest(base, `/api/artifacts/onlyoffice/callback?session=${encodeURIComponent(sessionToken)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signOnlyOfficeJwt({ payload: body }, SECRET)}` },
      body,
    });
    assert.equal(badOrigin.status, 200);
    assert.equal(badOrigin.body.error, 1);
    assert.equal(fetched, false);
  } finally {
    await close(server);
  }
});
