import assert from 'node:assert/strict';
import test from 'node:test';
import { McpClient } from '../src/mcp/mcp-client.js';
import {
  createScriptedTransport,
  itemAt,
  mcpResponder,
  mcpToolSchema,
  serverInfoSchema,
  toolCallResultSchema,
} from './helpers/mcp.js';

test('McpClient connect performs the initialize handshake + initialized notification', async () => {
  const transport = createScriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  const info = serverInfoSchema.parse(await client.connect());

  assert.equal(transport.started, true);
  assert.equal(info.name, 'fake-mcp');
  assert.equal(client.connected, true);
  assert.equal(itemAt(transport.sent, 0, 'initialize message').method, 'initialize');
  assert.equal(itemAt(transport.sent, 1, 'initialized notification').method, 'notifications/initialized');
  assert.equal(itemAt(transport.sent, 1, 'initialized notification').id, undefined);
});

test('McpClient.listTools returns the server tool list', async () => {
  const transport = createScriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  await client.connect();

  const tools = (await client.listTools()).map((tool) => mcpToolSchema.parse(tool));

  assert.equal(tools.length, 1);
  assert.equal(itemAt(tools, 0, 'MCP tool').name, 'echo');
});

test('McpClient.callTool forwards name + arguments and returns the result', async () => {
  const transport = createScriptedTransport(mcpResponder);
  const client = new McpClient({ transport });
  await client.connect();

  const result = toolCallResultSchema.parse(await client.callTool('echo', { text: 'hi' }));
  const callMessage = transport.sent.find((message) => message.method === 'tools/call');

  assert.equal(itemAt(result.content, 0, 'tool call content').text, 'called echo');
  assert.deepEqual(callMessage?.params, { name: 'echo', arguments: { text: 'hi' } });
});
