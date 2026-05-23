import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JsonRpcClient, JsonRpcError } from '../src/mcp/json-rpc.js';
import { StdioTransport } from '../src/mcp/stdio-transport.js';
import { McpClient } from '../src/mcp/mcp-client.js';

// ---- JSON-RPC core ----

test('JsonRpcClient resolves a request when a matching response arrives', async () => {
  const sent = [];
  const client = new JsonRpcClient({ send: (m) => sent.push(m) });
  const p = client.request('tools/list', { a: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jsonrpc, '2.0');
  assert.equal(sent[0].method, 'tools/list');
  assert.deepEqual(sent[0].params, { a: 1 });
  client.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { tools: [] } });
  assert.deepEqual(await p, { tools: [] });
});

test('JsonRpcClient rejects on a JSON-RPC error response', async () => {
  const sent = [];
  const client = new JsonRpcClient({ send: (m) => sent.push(m) });
  const p = client.request('boom');
  client.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32601, message: 'method not found' } });
  await assert.rejects(() => p, (err) => {
    assert.ok(err instanceof JsonRpcError);
    assert.equal(err.code, -32601);
    assert.match(err.message, /method not found/);
    return true;
  });
});

test('JsonRpcClient dispatches server notifications (no id) to handlers', () => {
  const client = new JsonRpcClient({ send: () => {} });
  const seen = [];
  client.onNotification((method, params) => seen.push([method, params]));
  client.handleMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: { pct: 50 } });
  assert.deepEqual(seen, [['notifications/progress', { pct: 50 }]]);
});

test('JsonRpcClient times out a request with no response', async () => {
  const client = new JsonRpcClient({ send: () => {}, timeoutMs: 20 });
  await assert.rejects(() => client.request('slow'), /timed out/);
});

test('JsonRpcClient.rejectAll fails every pending request', async () => {
  const client = new JsonRpcClient({ send: () => {} });
  const p = client.request('x');
  client.rejectAll(new Error('closed'));
  await assert.rejects(() => p, /closed/);
});

// ---- stdio transport (fake child) ----

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { writes: [], write(s) { this.writes.push(s); } };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  return child;
}

test('StdioTransport writes newline-delimited JSON to stdin', () => {
  const child = fakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: () => child });
  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0], '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
});

test('StdioTransport parses inbound lines, including a line split across chunks', () => {
  const child = fakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: () => child });
  const got = [];
  transport.onMessage((m) => got.push(m));
  transport.start();
  // one whole message, then a second delivered in two chunks
  child.stdout.emit('data', '{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0",');
  child.stdout.emit('data', '"id":2,"result":2}\n');
  assert.deepEqual(got, [
    { jsonrpc: '2.0', id: 1, result: 1 },
    { jsonrpc: '2.0', id: 2, result: 2 },
  ]);
});

test('StdioTransport.close kills the child', () => {
  const child = fakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: () => child });
  transport.start();
  transport.close();
  assert.equal(child.killed, true);
});

// ---- McpClient over a scripted transport ----

function scriptedTransport(responder) {
  let handler = null;
  return {
    started: false,
    sent: [],
    start() { this.started = true; },
    onMessage(cb) { handler = cb; },
    onClose() {},
    send(message) {
      this.sent.push(message);
      const reply = responder(message);
      if (reply !== undefined) {
        setImmediate(() => handler && handler(reply));
      }
    },
    close() { this.closed = true; },
  };
}

function mcpResponder(message) {
  if (message.id == null) {
    return undefined; // notification
  }
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake-mcp', version: '1.0' }, capabilities: { tools: {} } } };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'echo back' }] } };
  }
  if (message.method === 'tools/call') {
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `called ${message.params.name}` }] } };
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } };
}

test('McpClient connect performs the initialize handshake + initialized notification', async () => {
  const transport = scriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  const info = await client.connect();
  assert.equal(transport.started, true);
  assert.equal(info.name, 'fake-mcp');
  assert.equal(client.connected, true);
  // the second send is the "initialized" notification (no id)
  assert.equal(transport.sent[0].method, 'initialize');
  assert.equal(transport.sent[1].method, 'notifications/initialized');
  assert.equal(transport.sent[1].id, undefined);
});

test('McpClient.listTools returns the server tool list', async () => {
  const transport = scriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  await client.connect();
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'echo');
});

test('McpClient.callTool forwards name + arguments and returns the result', async () => {
  const transport = scriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  await client.connect();
  const result = await client.callTool('echo', { text: 'hi' });
  assert.equal(result.content[0].text, 'called echo');
  const callMsg = transport.sent.find((m) => m.method === 'tools/call');
  assert.deepEqual(callMsg.params, { name: 'echo', arguments: { text: 'hi' } });
});
