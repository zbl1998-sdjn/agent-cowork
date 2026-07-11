import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sendHtml } from '../src/routes/viz-route-support.js';
import { createServer } from '../src/server.js';
import {
  approveVizRender,
  artifactDataResponseSchema,
  parseInlineRenderResponse,
  parsePersistedRenderResponse,
  textRequest,
} from './helpers/artifacts.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';

test('POST /api/viz/render persists a live artifact and is idempotent', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'idempotency-key': 'viz-1' };
    const body = { title: '季度', kind: 'bar', data: { labels: ['Q1', 'Q2'], values: [3, 7] } };
    const approvedBody = await approveVizRender(base, body);
    const first = await jsonRequest(base, '/api/viz/render', { method: 'POST', headers, body: approvedBody });
    assert.equal(first.status, 200);
    const firstBody = parsePersistedRenderResponse(first.body);
    assert.match(firstBody.viewUrl, /^\/api\/artifacts\/live\/viz_/);
    assert.match(firstBody.html, /<script src="\/vendor\/chart\.umd\.min\.js"><\/script>/);

    const page = await textRequest(base, firstBody.viewUrl);
    assert.ok(page.type.includes('text/html'));
    assert.match(page.body, /id="refresh"/);
    const data = await jsonRequest(base, firstBody.dataUrl);
    const dataBody = artifactDataResponseSchema.parse(data.body);
    assert.equal(dataBody.viz.kind, 'bar');

    const replay = await jsonRequest(base, '/api/viz/render', { method: 'POST', headers, body: approvedBody });
    const replayBody = parsePersistedRenderResponse(replay.body);
    assert.equal(replayBody.idempotentReplay, true);
    assert.equal(replayBody.id, firstBody.id);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render persistent writes require a scoped approval receipt', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const body = { id: 'viz_requires_approval', kind: 'table', data: { columns: ['a'], rows: [['1']] } };
    const rejected = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-missing-approval' },
      body,
    });
    assert.equal(rejected.status, 428);
    assert.match(String(rejected.body.error), /approval/i);
    assert.equal(fs.existsSync(path.join(trustedRoot, '.AgentCowork', 'artifacts', 'viz_requires_approval.html')), false);

    const childRoot = path.join(trustedRoot, 'child');
    fs.mkdirSync(childRoot, { recursive: true });
    const childBody = {
      trustedRoot: childRoot,
      id: 'viz_child_root',
      kind: 'table',
      data: { columns: ['a'], rows: [['2']] },
    };
    const childGrantResponse = await jsonRequest(base, '/api/folder-grants', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-child-folder-grant' },
      body: { path: childRoot, displayName: 'Viz child root' },
    });
    assert.equal(childGrantResponse.status, 201);
    const childGrant = childGrantResponse.body.grant;
    assert.ok(childGrant && typeof childGrant === 'object' && !Array.isArray(childGrant));
    const childGrantId = String((childGrant as Record<string, unknown>).id || '');
    assert.match(childGrantId, /^grant_/);
    const childGrantHeaders = { 'x-workspace-grant-id': childGrantId };
    const approvedChild = await approveVizRender(base, childBody, childGrantHeaders);
    const wrongRoot = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-wrong-root' },
      body: { ...approvedChild, trustedRoot },
    });
    assert.equal(wrongRoot.status, 403);
    assert.match(String(wrongRoot.body.error), /approval/i);

    const accepted = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-with-approval', ...childGrantHeaders },
      body: approvedChild,
    });
    const acceptedBody = parsePersistedRenderResponse(accepted.body);
    assert.equal(accepted.status, 200);
    assert.equal(acceptedBody.persisted, true);
    assert.equal(fs.existsSync(path.join(childRoot, '.AgentCowork', 'artifacts', 'viz_child_root.html')), true);
    assert.equal(fs.existsSync(path.join(childRoot, '.AgentCowork', 'artifacts', 'viz_child_root.json')), true);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render/preview rejects malformed artifact ids before issuing approval', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render/preview', {
      method: 'POST',
      body: {
        id: '../bad',
        kind: 'table',
        data: { columns: ['a'], rows: [['1']] },
      },
    });
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /artifact id/i);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render with persist:false returns inline html only', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-inline' },
      body: { kind: 'table', persist: false, data: { columns: ['a'], rows: [['1']] } },
    });
    assert.equal(res.status, 200);
    const body = parseInlineRenderResponse(res.body);
    assert.equal(body.persisted, false);
    assert.equal(body.id, undefined);
    assert.match(body.html, /<table>/);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render rejects unknown kind (400) and missing key (428)', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const bad = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-bad' },
      body: { kind: 'pyramid', data: {} },
    });
    assert.equal(bad.status, 400);
    const noKey = await jsonRequest(base, '/api/viz/render', { method: 'POST', body: { kind: 'bar', data: {} } });
    assert.equal(noKey.status, 428);
  } finally {
    await close(server);
  }
});

test('sendHtml writes no-store HTML with byte-accurate length', () => {
  const writes: Array<{ status: number; headers: Record<string, string | number> }> = [];
  let ended: string | Buffer | undefined;
  const response = {
    writeHead(status: number, headers: Record<string, string | number>) {
      writes.push({ status, headers });
    },
    end(chunk?: string | Buffer) {
      ended = chunk;
    },
  };
  const body = '<h1>可视化</h1>';

  sendHtml(response, 202, body);

  assert.deepEqual(writes, [{
    status: 202,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    },
  }]);
  assert.equal(ended, body);
});
