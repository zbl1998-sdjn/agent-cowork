import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectMcpServers, closeMcpClients } from '../src/mcp/connect.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { createServer } from '../src/server.js';
import type { HostServer } from '../src/server.js';
import { itemAt, toolCallResultSchema } from './helpers/mcp.js';
import { closeTestServer } from './helpers/close-server.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-mcp-server.mjs', import.meta.url).href);

const toolListResponseSchema = z.object({
  tools: z.array(z.object({ name: z.string() }).passthrough()),
  mcpServers: z.array(z.string()),
}).passthrough();

const toolSearchResponseSchema = z.object({
  tools: z.array(z.object({ name: z.string() }).passthrough()),
}).passthrough();

const errorResponseSchema = z.object({
  error: z.string(),
}).passthrough();

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-mcpc-'));
}

function nodeExecPath(): string {
  const execPath = process.execPath;
  assert.ok(execPath, 'process.execPath should be available for MCP subprocess tests');
  return execPath;
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server should bind to a TCP port');
  const { port } = address;
  return `http://127.0.0.1:${port}`;
}

async function jsonRequest(
  base: string,
  route: string,
  { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body != null) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('connectMcpServers spawns a real MCP server and imports its tools', async () => {
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'mock', command: nodeExecPath(), args: [FIXTURE] }],
  });
  try {
    assert.equal(out.toolCount, 2);
    assert.equal(out.errors.length, 0);
    assert.equal(registry.has('mcp__mock__ping'), true);
    assert.equal(registry.has('mcp__mock__add'), true);
    const pong = toolCallResultSchema.parse(await registry.call('mcp__mock__ping', {}));
    assert.equal(itemAt(pong.content, 0, 'ping result content').text, 'pong');
    const sum = toolCallResultSchema.parse(await registry.call('mcp__mock__add', { a: 2, b: 5 }));
    assert.equal(itemAt(sum.content, 0, 'add result content').text, '7');
  } finally {
    closeMcpClients(out.clients);
  }
});

test('connectMcpServers records errors for bad specs without throwing', async () => {
  const registry = createToolRegistry();
  const out = await connectMcpServers({ registry, servers: [{ name: 'broken' }] });
  assert.equal(out.toolCount, 0);
  assert.equal(out.errors.length, 1);
  assert.match(itemAt(out.errors, 0, 'MCP connect error').error, /command/);
});

test('server.connectMcpServers exposes MCP tools through the HTTP routes', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const outcome = await server.connectMcpServers([{ name: 'mock', command: nodeExecPath(), args: [FIXTURE] }]);
    assert.equal(outcome.toolCount, 2);

    const tools = toolListResponseSchema.parse((await jsonRequest(base, '/api/tools')).body);
    assert.ok(tools.tools.some((tool) => tool.name === 'mcp__mock__ping'));
    assert.deepEqual(tools.mcpServers, ['mock']);

    const search = toolSearchResponseSchema.parse((await jsonRequest(base, '/api/tools/search?q=pong')).body);
    assert.ok(search.tools.some((tool) => tool.name === 'mcp__mock__ping'));

    const call = await jsonRequest(base, '/api/tools/call', {
      method: 'POST',
      headers: { 'idempotency-key': 'mcp-call-1' },
      body: { name: 'mcp__mock__add', args: { a: 4, b: 6 } },
    });
    assert.equal(call.status, 428);
    assert.match(errorResponseSchema.parse(call.body).error, /requires agent approval/i);
  } finally {
    await closeTestServer(server);
  }
});
