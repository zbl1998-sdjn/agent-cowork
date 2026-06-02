import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { JsonRpcClient, JsonRpcError } from '../src/mcp/json-rpc.js';
import { itemAt, parseJsonRpcMessage } from './helpers/mcp.js';
import type { JsonRpcMessage } from '../src/mcp/json-rpc.js';

const toolsResultSchema = z.object({
  tools: z.array(z.unknown()),
}).loose();

test('JsonRpcClient resolves a request when a matching response arrives', async () => {
  const sent: JsonRpcMessage[] = [];
  const client = new JsonRpcClient({ send: (message) => sent.push(parseJsonRpcMessage(message)) });
  const pending = client.request('tools/list', { a: 1 });
  const request = itemAt(sent, 0, 'JSON-RPC request');

  assert.equal(sent.length, 1);
  assert.equal(request.jsonrpc, '2.0');
  assert.equal(request.method, 'tools/list');
  assert.deepEqual(request.params, { a: 1 });

  client.handleMessage({ jsonrpc: '2.0', id: request.id, result: { tools: [] } });
  assert.deepEqual(toolsResultSchema.parse(await pending), { tools: [] });
});

test('JsonRpcClient rejects on a JSON-RPC error response', async () => {
  const sent: JsonRpcMessage[] = [];
  const client = new JsonRpcClient({ send: (message) => sent.push(parseJsonRpcMessage(message)) });
  const pending = client.request('boom');
  client.handleMessage({ jsonrpc: '2.0', id: itemAt(sent, 0, 'boom request').id, error: { code: -32601, message: 'method not found' } });

  await assert.rejects(() => pending, (error) => {
    assert.ok(error instanceof JsonRpcError);
    assert.equal(error.code, -32601);
    assert.match(error.message, /method not found/);
    return true;
  });
});

test('JsonRpcClient dispatches server notifications (no id) to handlers', () => {
  const client = new JsonRpcClient({ send: () => undefined });
  const seen: Array<[string, unknown]> = [];
  client.onNotification((method, params) => seen.push([method, params]));

  client.handleMessage({ jsonrpc: '2.0', method: 'notifications/progress', params: { pct: 50 } });

  assert.deepEqual(seen, [['notifications/progress', { pct: 50 }]]);
});

test('JsonRpcClient times out a request with no response', async () => {
  const client = new JsonRpcClient({ send: () => undefined, timeoutMs: 20 });
  await assert.rejects(() => client.request('slow'), /timed out/);
});

test('JsonRpcClient.rejectAll fails every pending request', async () => {
  const client = new JsonRpcClient({ send: () => undefined });
  const pending = client.request('x');
  client.rejectAll(new Error('closed'));
  await assert.rejects(() => pending, /closed/);
});
