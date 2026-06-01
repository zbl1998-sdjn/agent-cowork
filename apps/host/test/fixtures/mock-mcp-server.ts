// Minimal MCP-over-stdio server for tests. Speaks newline-delimited JSON-RPC.
// Tools: ping -> "pong", add -> a+b.
type JsonRpcId = string | number | null;

type ToolCallArguments = {
  a?: number;
  b?: number;
};

type JsonRpcRequest = {
  id?: JsonRpcId;
  method?: string;
  params?: {
    name?: string;
    arguments?: ToolCallArguments;
  };
};

type StdioProcess = typeof process & {
  stdin: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
  };
  stdout: {
    write(chunk: string): void;
  };
};

const stdio = process as StdioProcess;
let buffer = '';
stdio.stdin.setEncoding('utf8');
stdio.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf('\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      handle(JSON.parse(line) as JsonRpcRequest);
    }
    i = buffer.indexOf('\n');
  }
});

function reply(id: JsonRpcId, result: unknown): void {
  stdio.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(msg: JsonRpcRequest): void {
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
      const a = typeof args?.a === 'number' ? args.a : 0;
      const b = typeof args?.b === 'number' ? args.b : 0;
      reply(msg.id, { content: [{ type: 'text', text: String(a + b) }] });
      return;
    }
  }
  stdio.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } })}\n`);
}
