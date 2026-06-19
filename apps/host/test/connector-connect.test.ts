import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { handleConnectorRoutes } from '../src/routes/connector-routes.js';
import { createServer } from '../src/server.js';
import { arrayField, bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';

function tmp(): string {
  return tempRoot('kcw-cc-');
}

type CapturedResponse = HttpResponseLike & { status: number; body: string; json(): Record<string, unknown> };
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);

class FakeJsonRequest implements HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(method: string, private readonly body?: unknown) {
    this.method = method;
    this.headers = body === undefined ? {} : { 'content-type': 'application/json' };
    void Promise.resolve().then(() => {
      if (this.body !== undefined) this.emit('data', Buffer.from(JSON.stringify(this.body)));
      this.emit('end');
    });
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: RequestListener): this;
  on(event: string, listener: SupportedRequestListener): this {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener as RequestListener);
    this.listeners.set(event, listeners);
    return this;
  }

  resume(): void {
    // Test request bodies are emitted eagerly; there is nothing to drain.
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function capturedResponse(): CapturedResponse {
  return {
    status: 0,
    body: '',
    writeHead(statusCode) {
      this.status = statusCode;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      const parsed = JSON.parse(this.body || '{}') as unknown;
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'captured response body should be an object');
      return parsed as Record<string, unknown>;
    },
  };
}

function numberField(source: Record<string, unknown>, key: string, label = key): number {
  const value = source[key];
  if (typeof value !== 'number') {
    throw new TypeError(`${label} should be a number`);
  }
  return value;
}

function booleanField(source: Record<string, unknown>, key: string, label = key): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} should be a boolean`);
  }
  return value;
}

function stringArrayField(source: Record<string, unknown>, key: string, label = key): string[] {
  const value = source[key];
  assert.ok(Array.isArray(value), `${label} should be an array`);
  for (const [index, item] of value.entries()) {
    assert.equal(typeof item, 'string', `${label}[${index}] should be a string`);
  }
  return value as string[];
}

test('connector route fails closed when MCP connect is unavailable or backend connection fails', async () => {
  const root = tmp();
  const baseOptions = {
    pathname: '/api/connectors/connect',
    requestUrl: new URL('http://local/api/connectors/connect'),
    requestContext: { tenantId: 'tenant-route', userId: 'user-route' },
    toolRegistry: null,
    oauthSessions: new Map(),
    safeTrustedRoot: () => root,
    fsServerPath: path.join(root, 'fs-server.js'),
    fsServerRunnerPath: path.join(root, 'runner.js'),
  };

  let response = capturedResponse();
  assert.equal(await handleConnectorRoutes({
    ...baseOptions,
    request: new FakeJsonRequest('POST', { id: 'filesystem' }),
    response,
  }), true);
  assert.equal(response.status, 503);
  assert.match(String(response.json().error), /not available/i);

  response = capturedResponse();
  const backendError = new Error('spawn failed') as Error & { statusCode?: number };
  backendError.statusCode = 504;
  assert.equal(await handleConnectorRoutes({
    ...baseOptions,
    request: new FakeJsonRequest('POST', { id: 'filesystem' }),
    response,
    connectMcp: async () => {
      throw backendError;
    },
  }), true);
  assert.equal(response.status, 504);
  assert.match(String(response.json().error), /spawn failed/);

  response = capturedResponse();
  assert.equal(await handleConnectorRoutes({
    ...baseOptions,
    request: new FakeJsonRequest('POST', { id: 'filesystem' }),
    response,
    connectMcp: async () => ({ toolCount: 2, errors: [] }),
    toolRegistry: { mcpServers: () => ['fs'] },
  }), true);
  assert.equal(response.status, 200);
  assert.equal(response.json().name, 'fs');
  assert.deepEqual(response.json().mcpServers, ['fs']);
});

test('connector route rejects unsupported disconnects and ignores unrelated paths', async () => {
  const root = tmp();
  const baseOptions = {
    requestUrl: new URL('http://local/api/connectors/disconnect'),
    requestContext: { tenantId: 'tenant-route', userId: 'user-route' },
    oauthSessions: new Map(),
    safeTrustedRoot: () => root,
  };

  let response = capturedResponse();
  assert.equal(await handleConnectorRoutes({
    ...baseOptions,
    request: new FakeJsonRequest('POST', { id: 'filesystem' }),
    response,
    pathname: '/api/connectors/disconnect',
    toolRegistry: null,
  }), true);
  assert.equal(response.status, 400);
  assert.match(String(response.json().error), /unsupported connector/i);

  response = capturedResponse();
  assert.equal(await handleConnectorRoutes({
    ...baseOptions,
    request: new FakeJsonRequest('PATCH'),
    response,
    pathname: '/api/connectors/disconnect',
    toolRegistry: { unregisterMcpServer: () => ({ removed: true }) },
  }), false);
  assert.equal(response.status, 0);
});

test('POST /api/connectors/connect (filesystem) connects fs MCP server, tools become available', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'hi.txt'), 'hi', 'utf8');
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(numberField(conn.body, 'connected') >= 1, 'imported fs tools');
    assert.ok(stringArrayField(conn.body, 'mcpServers').includes('fs'));
    const tools = await jsonRequest(base, '/api/tools');
    assert.ok(arrayField(tools.body, 'tools').some((tool) => stringField(tool, 'name') === 'mcp__fs__read_text'));
    const list = await jsonRequest(base, '/api/connectors');
    assert.ok(stringArrayField(list.body, 'connected').includes('fs'));
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/disconnect revokes filesystem MCP tools', async () => {
  const root = tmp();
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    const conn = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: 'filesystem', trustedRoot: root } });
    assert.equal(conn.status, 200);
    assert.ok(stringArrayField(conn.body, 'mcpServers').includes('fs'));

    const out = await jsonRequest(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'filesystem' } });
    assert.equal(out.status, 200);
    assert.equal(stringField(out.body, 'name'), 'fs');
    assert.equal(booleanField(out.body, 'removed'), true);
    assert.ok(numberField(out.body, 'toolsRemoved') >= 1);
    assert.deepEqual(stringArrayField(out.body, 'mcpServers'), []);

    const tools = await jsonRequest(base, '/api/tools');
    assert.equal(arrayField(tools.body, 'tools').some((tool) => stringField(tool, 'name') === 'mcp__fs__read_text'), false);
    const list = await jsonRequest(base, '/api/connectors');
    assert.deepEqual(stringArrayField(list.body, 'connected'), []);
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/disconnect rejects an unsupported connector id', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/connectors/disconnect', { method: 'POST', body: { id: 'sqlite' } });
    assert.equal(res.status, 400);
    assert.match(stringField(res.body, 'error'), /unsupported connector/i);
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/connect requires id or command', async () => {
  const server = createServer({ trustedRoot: tmp(), enableScheduler: false });
  const base = await bind(server);
  try {
    const res = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: {} });
    assert.equal(res.status, 400);
  } finally {
    await close(server);
  }
});

test('POST /api/connectors/connect rejects malformed ids and escaped trusted roots before spawning', async () => {
  const root = tmp();
  const server = createServer({ trustedRoot: root, enableScheduler: false });
  const base = await bind(server);
  try {
    let res = await jsonRequest(base, '/api/connectors/connect', { method: 'POST', body: { id: '../filesystem' } });
    assert.equal(res.status, 400);
    assert.match(stringField(res.body, 'error'), /connector id/i);

    res = await jsonRequest(base, '/api/connectors/connect', {
      method: 'POST',
      body: { id: 'filesystem', trustedRoot: path.dirname(root) },
    });
    assert.equal(res.status, 400);
    assert.match(stringField(res.body, 'error'), /outside|trusted/i);
  } finally {
    await close(server);
  }
});
