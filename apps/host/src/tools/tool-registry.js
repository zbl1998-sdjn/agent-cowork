// A unified tool registry.
//
// Built-in tools (sandbox exec / run-code / recipes) and tools exposed by
// connected MCP servers all live in one namespace here. Callers can:
//   - list()            -> every tool descriptor (no handlers leaked)
//   - search(query)     -> keyword-ranked descriptors (the "ToolSearch" analog:
//                          a host with many MCP tools doesn't dump them all,
//                          it surfaces the relevant few on demand)
//   - get(name)         -> the full entry (descriptor + handler)
//   - call(name, args)  -> invoke a tool's handler
//   - registerMcpClient(server, client) -> connect + import that server's tools
//
// MCP tools are namespaced `mcp__<server>__<tool>` so they never collide with
// built-ins and the source server is always recoverable from the name.

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter(Boolean);
}

function scoreTool(descriptor, terms) {
  if (terms.length === 0) {
    return 0;
  }
  const name = descriptor.name.toLowerCase();
  const haystack = `${name} ${String(descriptor.description || '').toLowerCase()}`;
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) {
      score += 3; // a name hit is worth more than a description hit
    } else if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

export class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._mcpClients = new Map();
  }

  register(entry) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error('ToolRegistry.register: name is required');
    }
    if (typeof entry.handler !== 'function') {
      throw new Error(`ToolRegistry.register: tool "${entry.name}" needs a handler`);
    }
    this._tools.set(entry.name, {
      name: entry.name,
      description: entry.description || '',
      source: entry.source || 'builtin',
      inputSchema: entry.inputSchema || null,
      handler: entry.handler,
    });
    return this;
  }

  registerMany(entries = []) {
    for (const entry of entries) {
      this.register(entry);
    }
    return this;
  }

  has(name) {
    return this._tools.has(name);
  }

  get(name) {
    return this._tools.get(name) || null;
  }

  descriptor(name) {
    const entry = this._tools.get(name);
    if (!entry) {
      return null;
    }
    const { handler, ...rest } = entry;
    return rest;
  }

  list() {
    return [...this._tools.values()].map(({ handler, ...rest }) => rest);
  }

  search(query, { limit = 10 } = {}) {
    const terms = tokenize(query);
    const all = this.list();
    if (terms.length === 0) {
      return all.slice(0, limit);
    }
    return all
      .map((descriptor) => ({ descriptor, score: scoreTool(descriptor, terms) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.descriptor.name.localeCompare(b.descriptor.name))
      .slice(0, limit)
      .map((row) => ({ ...row.descriptor, score: row.score }));
  }

  async call(name, args = {}, ctx = {}) {
    const entry = this._tools.get(name);
    if (!entry) {
      const err = new Error(`Unknown tool: ${name}`);
      err.statusCode = 404;
      throw err;
    }
    return entry.handler(args, ctx);
  }

  async registerMcpClient(serverName, client) {
    if (!serverName || !client) {
      throw new Error('registerMcpClient: serverName and client are required');
    }
    await client.connect();
    const tools = await client.listTools();
    this._mcpClients.set(serverName, client);
    for (const tool of tools) {
      const name = `mcp__${serverName}__${tool.name}`;
      this.register({
        name,
        description: tool.description || '',
        source: `mcp:${serverName}`,
        inputSchema: tool.inputSchema || null,
        handler: (args) => client.callTool(tool.name, args),
      });
    }
    return tools.length;
  }

  mcpServers() {
    return [...this._mcpClients.keys()];
  }
}

export function createToolRegistry() {
  return new ToolRegistry();
}
