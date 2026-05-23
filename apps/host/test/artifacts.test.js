import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderViz, VIZ_KINDS } from '../src/artifacts/viz.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-art-'));
}

// ---- viz renderer ----

test('renderViz bar chart embeds Chart.js, the config, and the title', () => {
  const html = renderViz({
    title: '季度收入',
    kind: 'bar',
    data: { labels: ['Q1', 'Q2'], values: [10, 20] },
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js/);
  assert.match(html, /new window\.Chart/);
  assert.match(html, /"labels":\["Q1","Q2"\]/);
  assert.match(html, /季度收入/);
});

test('renderViz supports line / pie / doughnut kinds', () => {
  for (const kind of ['line', 'pie', 'doughnut']) {
    const html = renderViz({ kind, data: { labels: ['a'], values: [1] } });
    assert.match(html, new RegExp(`"type":"${kind}"`));
  }
});

test('renderViz mermaid embeds the definition and Mermaid lib', () => {
  const html = renderViz({ title: '流程', kind: 'mermaid', data: { definition: 'graph TD; A-->B' } });
  assert.match(html, /class="mermaid"/);
  assert.match(html, /graph TD; A--&gt;B/); // > is HTML-escaped inside the <pre>
  assert.match(html, /cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid/);
});

test('renderViz table escapes cell content', () => {
  const html = renderViz({
    kind: 'table',
    data: { columns: ['名称', '值'], rows: [['<script>', '1']] },
  });
  assert.match(html, /<table>/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<td><script></td>'), 'raw script tag must not appear in a cell');
});

test('renderViz throws 400 on an unknown kind and on empty mermaid/table', () => {
  assert.throws(() => renderViz({ kind: 'pyramid' }), (err) => { assert.equal(err.statusCode, 400); return true; });
  assert.throws(() => renderViz({ kind: 'mermaid', data: {} }), /definition/);
  assert.throws(() => renderViz({ kind: 'table', data: {} }), /columns or rows/);
});

test('renderViz neutralizes script-breakout attempts in chart data', () => {
  const evil = '</script><script>alert(1)</script>';
  const html = renderViz({ kind: 'bar', data: { labels: [evil], values: [1] } });
  assert.ok(!html.includes('<script>alert(1)'), 'injected script must be neutralized');
  assert.match(html, /\\u003c\/script\\u003e/, 'angle brackets are unicode-escaped in the data block');
});

test('renderViz escapes U+2028 inside embedded JSON', () => {
  const sep = String.fromCharCode(0x2028);
  const html = renderViz({ kind: 'bar', data: { labels: [`a${sep}b`], values: [1] } });
  assert.ok(!html.includes(sep), 'raw line separator must not survive in the script');
  assert.match(html, /\\u2028/);
});

test('VIZ_KINDS lists the supported kinds', () => {
  assert.deepEqual(VIZ_KINDS, ['bar', 'line', 'pie', 'doughnut', 'mermaid', 'table']);
});

// ---- live artifact builder ----

import { buildLiveArtifact, readArtifactManifest, readLiveArtifactHtml, createArtifactId } from '../src/artifacts/live-artifact.js';
import { createServer } from '../src/server.js';

async function bind(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function jsonRequest(base, route, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  return { status: response.status, type, body: type.includes('json') && text ? JSON.parse(text) : text };
}

test('buildLiveArtifact writes a live page + manifest with a Refresh hook', () => {
  const root = tempRoot();
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '收入',
    viz: { kind: 'bar', data: { labels: ['Q1'], values: [9] } },
  });
  assert.match(out.id, /^viz_/);
  assert.equal(out.relativePath, `.AgentCowork/artifacts/${out.id}.html`);
  const html = fs.readFileSync(out.htmlPath, 'utf8');
  assert.match(html, /id="refresh"/);
  assert.match(html, /DATA_URL/);
  assert.match(html, /"labels":\["Q1"\]/);
  const manifest = readArtifactManifest({ trustedRoot: root, id: out.id });
  assert.equal(manifest.viz.kind, 'bar');
  assert.equal(manifest.dataUrl, `/api/artifacts/data/${out.id}`);
});

test('readArtifactManifest / readLiveArtifactHtml reject bad ids and missing artifacts', () => {
  const root = tempRoot();
  assert.throws(() => readArtifactManifest({ trustedRoot: root, id: '../etc' }), (e) => { assert.equal(e.statusCode, 400); return true; });
  assert.throws(() => readLiveArtifactHtml({ trustedRoot: root, id: createArtifactId() }), (e) => { assert.equal(e.statusCode, 404); return true; });
});

// ---- viz / artifact routes ----

test('POST /api/viz/render persists a live artifact and is idempotent', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const headers = { 'idempotency-key': 'viz-1' };
    const body = { title: '季度', kind: 'bar', data: { labels: ['Q1', 'Q2'], values: [3, 7] } };
    const first = await jsonRequest(base, '/api/viz/render', { method: 'POST', headers, body });
    assert.equal(first.status, 200);
    assert.equal(first.body.persisted, true);
    assert.match(first.body.viewUrl, /^\/api\/artifacts\/live\/viz_/);
    assert.match(first.body.html, /new window\.Chart/);

    // the live page is fetchable and the data endpoint returns the viz
    const page = await jsonRequest(base, first.body.viewUrl);
    assert.ok(page.type.includes('text/html'));
    assert.match(page.body, /id="refresh"/);
    const data = await jsonRequest(base, first.body.dataUrl);
    assert.equal(data.body.viz.kind, 'bar');

    const replay = await jsonRequest(base, '/api/viz/render', { method: 'POST', headers, body });
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.id, first.body.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/viz/render with persist:false returns inline html only', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-inline' },
      body: { kind: 'table', persist: false, data: { columns: ['a'], rows: [['1']] } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.persisted, false);
    assert.equal(res.body.id, undefined);
    assert.match(res.body.html, /<table>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/viz/render rejects unknown kind (400) and missing key (428)', async () => {
  const trustedRoot = tempRoot();
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
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/artifacts/data/:id 404s an unknown artifact', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/artifacts/data/viz_00000000000000_deadbeef');
    assert.equal(res.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
