import assert from 'node:assert/strict';
import test from 'node:test';
import { StdioTransport } from '../src/mcp/stdio-transport.js';
import {
  createFakeChild,
  parseJsonRpcMessage,
  spawnFakeChild,
} from './helpers/mcp.js';
import type { JsonRpcMessage } from '../src/mcp/json-rpc.js';

test('StdioTransport writes newline-delimited JSON to stdin', () => {
  const child = createFakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: spawnFakeChild(child) });

  transport.start();
  transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });

  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0], '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
});

test('StdioTransport parses inbound lines, including a line split across chunks', () => {
  const child = createFakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: spawnFakeChild(child) });
  const got: JsonRpcMessage[] = [];
  transport.onMessage((message) => got.push(parseJsonRpcMessage(message)));
  transport.start();

  child.stdout.emit('data', '{"jsonrpc":"2.0","id":1,"result":1}\n{"jsonrpc":"2.0",');
  child.stdout.emit('data', '"id":2,"result":2}\n');

  assert.deepEqual(got, [
    { jsonrpc: '2.0', id: 1, result: 1 },
    { jsonrpc: '2.0', id: 2, result: 2 },
  ]);
});

test('StdioTransport.close kills the child', () => {
  const child = createFakeChild();
  const transport = new StdioTransport({ command: 'srv', spawn: spawnFakeChild(child) });

  transport.start();
  transport.close();

  assert.equal(child.killed, true);
});
