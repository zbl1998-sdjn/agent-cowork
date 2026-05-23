import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectMcpServers, closeMcpClients } from '../src/mcp/connect.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { createServer } from '../src/server.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url));

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mcpc-'));
}

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
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('connectMcpServers spawns a real MCP server and imports its tools', async () => {
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'mock', command: process.execPath, args: [FIXTURE] }],
  });
  try {
    assert.equal(out.toolCount, 2);
    assert.equal(out.errors.length, 0);
    assert.equal(registry.has('mcp__mock__ping'), true);
    assert.equal(registry.has('mcp__mock__add'), true);
    const pong = await registry.call('mcp__mock__ping', {});
    assert.equal(pong.content[0].text, 'pong');
    const sum = await registry.call('mcp__mock__add', { a: 2, b: 5 });
    assert.equal(sum.content[0].text, '7');
  } finally {
    closeMcpClients(out.clients);
  }
});

test('connectMcpServers records errors for bad specs without throwing', async () => {
  const registry = createToolRegistry();
  const out = await connectMcpServers({ registry, servers: [{ name: 'broken' }] });
  assert.equal(out.toolCount, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].error, /command/);
});

test('server.connectMcpServers exposes MCP tools through the HTTP routes', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const outcome = await server.connectMcpServers([{ name: 'mock', command: process.execPath, args: [FIXTURE] }]);
    assert.equal(outcome.toolCount, 2);

    const tools = await jsonRequest(base, '/api/tools');
    assert.ok(tools.body.tools.some((t) => t.name === 'mcp__mock__ping'));
    assert.deepEqual(tools.body.mcpServers, ['mock']);

    const search = await jsonRequest(base, '/api/tools/search?q=pong');
    assert.ok(search.body.tools.some((t) => t.name === 'mcp__mock__ping'));

    const call = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'mcp-call-1' },
      body: { name: 'mcp__mock__add', args: { a: 4, b: 6 } },
    });
    assert.equal(call.status, 200);
    assert.equal(call.body.result.content[0].text, '10');
  } finally {
    server.closeMcp();
    await new Promise((resolve) => server.close(resolve));
  }
});
