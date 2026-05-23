// Minimal MCP-over-stdio server for tests. Speaks newline-delimited JSON-RPC.
// Tools: ping -> "pong", add -> a+b.
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      handle(JSON.parse(line));
    }
    i = buffer.indexOf('\n');
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(msg) {
  if (msg.id == null) {
    return; // notification (e.g. notifications/initialized)
  }
  if (msg.method === 'initialize') {
    reply(msg.id, { serverInfo: { name: 'mock-mcp', version: '0.0.1' }, capabilities: { tools: {} } });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: [
      { name: 'ping', description: 'returns pong' },
      { name: 'add', description: 'adds a and b' },
    ] });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'ping') {
      reply(msg.id, { content: [{ type: 'text', text: 'pong' }] });
      return;
    }
    if (name === 'add') {
      reply(msg.id, { content: [{ type: 'text', text: String((args?.a || 0) + (args?.b || 0)) }] });
      return;
    }
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } })}\n`);
}
