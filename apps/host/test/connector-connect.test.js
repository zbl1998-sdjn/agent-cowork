import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { closeTestServer } from './helpers/close-server.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-cc-')); }
async function bind(s) { await new Promise((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${s.address().port}`; }
async function J(base, route, opt = {}) {
  const res = await fetch(`${base}${route}`, { method: opt.method || 'GET', headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null };
}

test('POST /api/connectors/connect (filesystem) connects fs MCP server, tools become available', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'hi.txt'), 'hi', 'utf8');
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await J(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(conn.body.connected >= 1, 'imported fs tools');
    assert.ok(conn.body.mcpServers.includes('fs'));
    const tools = await J(base, '/api/tools');
    assert.ok(tools.body.tools.some((t) => t.name === 'mcp__fs__read_text'));
    const list = await J(base, '/api/connectors');
    assert.ok(list.body.connected.includes('fs'));
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/connectors/disconnect revokes filesystem MCP tools', async () => {
  const root = tmp();
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await J(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(conn.body.mcpServers.includes('fs'));

    const out = await J(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'filesystem' } });
    assert.equal(out.status, 200);
    assert.equal(out.body.name, 'fs');
    assert.equal(out.body.removed, true);
    assert.ok(out.body.toolsRemoved >= 1);
    assert.deepEqual(out.body.mcpServers, []);

    const tools = await J(base, '/api/tools');
    assert.equal(tools.body.tools.some((t) => t.name === 'mcp__fs__read_text'), false);
    const list = await J(base, '/api/connectors');
    assert.deepEqual(list.body.connected, []);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/connectors/disconnect rejects an unsupported connector id', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await J(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'sqlite' } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unsupported connector/i);
  } finally {
    await closeTestServer(server);
  }
});

test('POST /api/connectors/connect requires id or command', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await J(base, '/api/connectors/connect', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
  } finally {
    await closeTestServer(server);
  }
});
