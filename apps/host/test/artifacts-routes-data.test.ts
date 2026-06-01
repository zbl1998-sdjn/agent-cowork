import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  approveVizRender,
  artifactDataResponseSchema,
  parsePersistedRenderResponse,
} from './helpers/artifacts.js';
import { bind, close, jsonRequest, recordValue, tempRoot } from './helpers/host-http.js';
import type { McpRegistry } from '../src/mcp/connect.js';

type LiveDataToolRegistry = McpRegistry & {
  descriptor(name: string): {
    source?: string;
    name?: string;
    risk?: string;
    mutating?: boolean;
  } | null;
  call(name: string, args: Record<string, unknown>, context: { trustedRoot: string; context?: unknown }): unknown | Promise<unknown>;
};

test('POST /api/viz/render persists a live artifact with a refreshable file-json data source', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const sourceRel = 'data/refresh.json';
  const sourcePath = path.join(trustedRoot, sourceRel);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'bar', data: { labels: ['old'], values: [1] } } }), 'utf8');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const body = {
      title: '可刷新图',
      kind: 'bar',
      data: { labels: ['initial'], values: [0] },
      dataSource: { type: 'file-json', path: sourceRel },
    };
    const approvedBody = await approveVizRender(base, body);
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-refresh-source' },
      body: approvedBody,
    });
    assert.equal(res.status, 200);
    const renderBody = parsePersistedRenderResponse(res.body);

    fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'bar', data: { labels: ['new'], values: [9] } } }), 'utf8');
    const data = await jsonRequest(base, renderBody.dataUrl);
    assert.equal(data.status, 200);
    const dataBody = artifactDataResponseSchema.parse(data.body);
    assert.equal(dataBody.dataSource?.type, 'file-json');
    const vizData = recordValue(dataBody.viz.data, 'refreshable chart data');
    assert.deepEqual(vizData.labels, ['new']);
    assert.deepEqual(vizData.values, [9]);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render refreshes from a connected filesystem connector data source', async () => {
  const trustedRoot = tempRoot('kcw-art-');
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

    const body = {
      title: '连接器活页',
      kind: 'table',
      data: { columns: ['name'], rows: [['initial']] },
      dataSource: {
        type: 'connector-tool',
        tool: 'mcp__fs__read_text',
        args: { path: sourceRel },
      },
    };
    const approvedBody = await approveVizRender(base, body);
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-connector-source' },
      body: approvedBody,
    });
    assert.equal(res.status, 200);
    const renderBody = parsePersistedRenderResponse(res.body);

    fs.writeFileSync(sourcePath, JSON.stringify({ viz: { kind: 'table', data: { columns: ['name'], rows: [['new']] } } }), 'utf8');
    const data = await jsonRequest(base, renderBody.dataUrl);
    assert.equal(data.status, 200);
    const dataBody = artifactDataResponseSchema.parse(data.body);
    assert.equal(dataBody.dataSource?.type, 'connector-tool');
    assert.equal(dataBody.dataSource?.tool, 'mcp__fs__read_text');
    const vizData = recordValue(dataBody.viz.data, 'connector table data');
    assert.deepEqual(vizData.rows, [['new']]);
  } finally {
    server.closeMcp?.();
    await close(server);
  }
});

test('GET /api/artifacts/data rejects connector data sources before the connector tool is connected', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const body = {
      title: '未连接数据源',
      kind: 'table',
      data: { columns: ['name'], rows: [['initial']] },
      dataSource: {
        type: 'connector-tool',
        tool: 'mcp__fs__read_text',
        args: { path: 'data/live.json' },
      },
    };
    const approvedBody = await approveVizRender(base, body);
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-connector-missing-source' },
      body: approvedBody,
    });
    assert.equal(res.status, 200);
    const renderBody = parsePersistedRenderResponse(res.body);

    const data = await jsonRequest(base, renderBody.dataUrl);
    assert.equal(data.status, 409);
    assert.match(String(data.body.error), /connector tool is not connected/);
  } finally {
    await close(server);
  }
});

test('GET /api/artifacts/data rejects high-risk MCP tools as connector data sources', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  let called = false;
  const toolRegistry: LiveDataToolRegistry = {
    registerMcpClient: () => 0,
    descriptor: (name) => (name === 'mcp__demo__danger'
      ? { name, source: 'mcp:demo', risk: 'high', mutating: true }
      : null),
    call: async () => {
      called = true;
      return { viz: { kind: 'table', data: { columns: ['bad'], rows: [['bad']] } } };
    },
  };
  const server = createServer({ trustedRoot, enableScheduler: false, toolRegistry });
  const base = await bind(server);
  try {
    const body = {
      title: '危险数据源',
      kind: 'table',
      data: { columns: ['name'], rows: [['initial']] },
      dataSource: {
        type: 'connector-tool',
        tool: 'mcp__demo__danger',
        args: {},
      },
    };
    const approvedBody = await approveVizRender(base, body);
    const res = await jsonRequest(base, '/api/viz/render', {
      method: 'POST',
      headers: { 'idempotency-key': 'viz-danger-connector-source' },
      body: approvedBody,
    });
    assert.equal(res.status, 200);
    const renderBody = parsePersistedRenderResponse(res.body);

    const data = await jsonRequest(base, renderBody.dataUrl);
    assert.equal(data.status, 403);
    assert.equal(called, false);
    assert.match(String(data.body.error), /not allowed as a live data source/);
  } finally {
    await close(server);
  }
});

test('POST /api/viz/render rejects a file-json data source outside trustedRoot', async () => {
  const trustedRoot = tempRoot('kcw-art-');
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
    assert.match(String(res.body.error), /Path escaped trusted root/);
  } finally {
    await close(server);
  }
});

test('GET /api/artifacts/data/:id 404s an unknown artifact', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/artifacts/data/viz_00000000000000_deadbeef');
    assert.equal(res.status, 404);
  } finally {
    await close(server);
  }
});

test('GET /api/artifacts/data/:id rejects encoded path separators at the route boundary', async () => {
  const trustedRoot = tempRoot('kcw-art-');
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/artifacts/data/viz_bad%2Fescape');
    assert.equal(res.status, 400);
    assert.match(String(res.body.error), /invalid artifact id/i);
  } finally {
    await close(server);
  }
});
