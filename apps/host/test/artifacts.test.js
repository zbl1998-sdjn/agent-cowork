import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderViz, VIZ_KINDS } from '../src/artifacts/viz.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';

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

import {
  buildLiveArtifact,
  readArtifactManifest,
  readLiveArtifactHtml,
  createArtifactId,
  renderLivePage,
  refreshLiveArtifactData,
} from '../src/artifacts/live-artifact.js';
import { listArtifacts } from '../src/artifacts/artifact-catalog.js';
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

test('renderLivePage escapes title and script-sensitive data while preserving refresh wiring', () => {
  const html = renderLivePage({
    id: 'viz_escape',
    title: '<script>alert(1)</script>',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['</script><img src=x>']] } },
    dataUrl: '/api/artifacts/data/viz_escape',
  });
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<h1><script>/);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /DATA_URL = "\/api\/artifacts\/data\/viz_escape"/);
  assert.match(html, /agent-cowork:live-artifact-data/);
});

test('readArtifactManifest / readLiveArtifactHtml reject bad ids and missing artifacts', () => {
  const root = tempRoot();
  assert.throws(() => readArtifactManifest({ trustedRoot: root, id: '../etc' }), (e) => { assert.equal(e.statusCode, 400); return true; });
  assert.throws(() => readLiveArtifactHtml({ trustedRoot: root, id: createArtifactId() }), (e) => { assert.equal(e.statusCode, 404); return true; });
});

test('refreshLiveArtifactData reads a workspace file-json data source on demand', () => {
  const root = tempRoot();
  const sourceRel = 'data/live-viz.json';
  const sourcePath = path.join(root, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['before']] } } }), 'utf8');
  const out = buildLiveArtifact({
    trustedRoot: root,
    title: '动态表',
    viz: { kind: 'table', data: { columns: ['name'], rows: [['initial']] } },
    dataSource: { type: 'file-json', path: sourceRel },
  });

  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['after']] } } }), 'utf8');
  const data = refreshLiveArtifactData({ trustedRoot: root, id: out.id, now: new Date('2026-01-02T03:04:05.000Z') });
  assert.equal(data.refreshedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(data.dataSource.type, 'file-json');
  assert.deepEqual(data.viz.data.rows, [['after']]);
});

test('buildLiveArtifact rejects file-json data sources outside trustedRoot', () => {
  const root = tempRoot();
  assert.throws(
    () => buildLiveArtifact({
      trustedRoot: root,
      title: '越界',
      viz: { kind: 'table', data: { columns: ['a'], rows: [['1']] } },
      dataSource: { type: 'file-json', path: '../outside.json' },
    }),
    /Path escaped trusted root/,
  );
});

test('listArtifacts rejects a symlinked artifact root outside trustedRoot', () => {
  const root = tempRoot();
  const outside = tempRoot();
  fs.writeFileSync(path.join(outside, 'leak.md'), 'outside', 'utf8');
  fs.mkdirSync(path.join(root, '.AgentCowork'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.AgentCowork', 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => listArtifacts({ trustedRoot: root }),
    /Path escaped trusted root/,
  );
});

test('listArtifacts labels Office artifact kinds explicitly', () => {
  const root = tempRoot();
  const dir = path.join(root, '.AgentCowork', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['report.docx', 'data.xlsx', 'slides.pptx', 'memo.pdf']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }

  const byName = Object.fromEntries(listArtifacts({ trustedRoot: root, limit: 10 }).map((item) => [item.name, item.kind]));

  assert.equal(byName['report.docx'], 'word');
  assert.equal(byName['data.xlsx'], 'spreadsheet');
  assert.equal(byName['slides.pptx'], 'presentation');
  assert.equal(byName['memo.pdf'], 'pdf');
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

test('POST /api/viz/render persists a live artifact with a refreshable file-json data source', async () => {
  const trustedRoot = tempRoot();
  const sourceRel = 'data/refresh.json';
  const sourcePath = path.join(trustedRoot, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'bar', data: { labels: ['old'], values: [1] } } }), 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-refresh-source' },
      body: {
        title: '可刷新图',
        kind: 'bar',
        data: { labels: ['initial'], values: [0] },
        dataSource: { type: 'file-json', path: sourceRel },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.persisted, true);

    fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'bar', data: { labels: ['new'], values: [9] } } }), 'utf8');
    const data = await jsonRequest(base, res.body.dataUrl);
    assert.equal(data.status, 200);
    assert.equal(data.body.dataSource.type, 'file-json');
    assert.deepEqual(data.body.viz.data.labels, ['new']);
    assert.deepEqual(data.body.viz.data.values, [9]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/viz/render refreshes from a connected filesystem connector data source', async () => {
  const trustedRoot = tempRoot();
  const sourceRel = 'data/connector-refresh.json';
  const sourcePath = path.join(trustedRoot, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['old']] } } }), 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const connected = await jsonRequest(base, '/api/connectors/connect', {
      method: 'POST',
      headers: { 'idempotency-key': 'connector-live-connect' },
      body: { id: 'filesystem', trustedRoot },
    });
    assert.equal(connected.status, 200);

    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-connector-source' },
      body: {
        title: '连接器活页',
        kind: 'table',
        data: { columns: ['name'], rows: [['initial']] },
        dataSource: {
          type: 'connector-tool',
          tool: 'mcp__fs__read_text',
          args: { path: sourceRel },
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.persisted, true);

    fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['new']] } } }), 'utf8');
    const data = await jsonRequest(base, res.body.dataUrl);
    assert.equal(data.status, 200);
    assert.equal(data.body.dataSource.type, 'connector-tool');
    assert.equal(data.body.dataSource.tool, 'mcp__fs__read_text');
    assert.deepEqual(data.body.viz.data.rows, [['new']]);
  } finally {
    server.closeMcp?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/artifacts/data rejects connector data sources before the connector tool is connected', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-connector-missing-source' },
      body: {
        title: '未连接数据源',
        kind: 'table',
        data: { columns: ['name'], rows: [['initial']] },
        dataSource: {
          type: 'connector-tool',
          tool: 'mcp__fs__read_text',
          args: { path: 'data/live.json' },
        },
      },
    });
    assert.equal(res.status, 200);

    const data = await jsonRequest(base, res.body.dataUrl);
    assert.equal(data.status, 409);
    assert.match(data.body.error, /connector tool is not connected/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('GET /api/artifacts/data rejects high-risk MCP tools as connector data sources', async () => {
  const trustedRoot = tempRoot();
  let called = false;
  const toolRegistry = createToolRegistry().register({
    name: 'mcp__demo__danger',
    description: 'danger',
    source: 'mcp:demo',
    risk: 'high',
    mutating: true,
    handler: async () => {
      called = true;
      return { viz: { kind: 'table', data: { columns: ['bad'], rows: [['bad']] } } };
    },
  });
  const server = createServer({ trustedRoot, enableScheduler: false, toolRegistry });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-danger-connector-source' },
      body: {
        title: '危险数据源',
        kind: 'table',
        data: { columns: ['name'], rows: [['initial']] },
        dataSource: {
          type: 'connector-tool',
          tool: 'mcp__demo__danger',
          args: {},
        },
      },
    });
    assert.equal(res.status, 200);

    const data = await jsonRequest(base, res.body.dataUrl);
    assert.equal(data.status, 403);
    assert.equal(called, false);
    assert.match(data.body.error, /not allowed as a live data source/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/viz/render rejects a file-json data source outside trustedRoot', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-refresh-escape' },
      body: {
        title: 'bad',
        kind: 'table',
        data: { columns: ['a'], rows: [['1']] },
        dataSource: { type: 'file-json', path: '../outside.json' },
      },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Path escaped trusted root/);
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
