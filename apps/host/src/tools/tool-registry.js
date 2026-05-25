// @ts-check

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

/**
 * @typedef {Error & { statusCode?: number }} HttpError
 * @typedef {(args?: any, ctx?: any) => any | Promise<any>} ToolHandler
 * @typedef {{ name: string, description?: string, source?: string, inputSchema?: any, risk?: string, mutating?: boolean, requiresApproval?: boolean, handler: ToolHandler }} ToolEntry
 * @typedef {{ name: string, description: string, source: string, inputSchema: any, risk: string, mutating: boolean, requiresApproval: boolean }} ToolDescriptor
 * @typedef {{ name: string, description?: string, inputSchema?: any }} McpTool
 * @typedef {{ connect(): void | Promise<void>, listTools(): McpTool[] | Promise<McpTool[]>, callTool(name: string, args?: any): any | Promise<any>, close?: () => void }} McpClient
 */

/** @param {unknown} text */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter(Boolean);
}

/**
 * @param {ToolDescriptor} descriptor
 * @param {string[]} terms
 */
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
    /** @type {Map<string, ToolEntry>} */
    this._tools = new Map();
    /** @type {Map<string, McpClient>} */
    this._mcpClients = new Map();
  }

  /** @param {ToolEntry} entry */
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
      risk: entry.risk || 'low',
      mutating: entry.mutating === true,
      requiresApproval: entry.requiresApproval === true,
      handler: entry.handler,
    });
    return this;
  }

  /** @param {ToolEntry[]} [entries] */
  registerMany(entries = []) {
    for (const entry of entries) {
      this.register(entry);
    }
    return this;
  }

  /** @param {string} name */
  has(name) {
    return this._tools.has(name);
  }

  /** @param {string} name */
  get(name) {
    return this._tools.get(name) || null;
  }

  /** @param {string} name */
  descriptor(name) {
    const entry = this._tools.get(name);
    if (!entry) {
      return null;
    }
    return {
      name: entry.name,
      description: entry.description || '',
      source: entry.source || 'builtin',
      inputSchema: entry.inputSchema || null,
      risk: entry.risk || 'low',
      mutating: entry.mutating === true,
      requiresApproval: entry.requiresApproval === true,
    };
  }

  /** @returns {ToolDescriptor[]} */
  list() {
    return [...this._tools.values()].map((entry) => ({
      name: entry.name,
      description: entry.description || '',
      source: entry.source || 'builtin',
      inputSchema: entry.inputSchema || null,
      risk: entry.risk || 'low',
      mutating: entry.mutating === true,
      requiresApproval: entry.requiresApproval === true,
    }));
  }

  /**
   * @param {string} query
   * @param {{ limit?: number }} [options]
   */
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

  /**
   * @param {string} name
   * @param {any} [args]
   * @param {any} [ctx]
   */
  async call(name, args = {}, ctx = {}) {
    const entry = this._tools.get(name);
    if (!entry) {
      const err = /** @type {HttpError} */ (new Error(`Unknown tool: ${name}`));
      err.statusCode = 404;
      throw err;
    }
    return entry.handler(args, ctx);
  }

  /**
   * @param {string} serverName
   * @param {McpClient} client
   */
  async registerMcpClient(serverName, client) {
    if (!serverName || !client) {
      throw new Error('registerMcpClient: serverName and client are required');
    }
    await client.connect();
    const tools = await client.listTools();
    this._mcpClients.set(serverName, client);
    for (const tool of tools) {
      const name = `mcp__${serverName}__${tool.name}`;
      const handler = /** @type {ToolHandler} */ ((args) => client.callTool(tool.name, args));
      this.register({
        name,
        description: tool.description || '',
        source: `mcp:${serverName}`,
        inputSchema: tool.inputSchema || null,
        risk: 'high',
        mutating: true,
        requiresApproval: true,
        handler,
      });
    }
    return tools.length;
  }

  /** @param {string} serverName */
  unregisterMcpServer(serverName) {
    if (!serverName) {
      throw new Error('unregisterMcpServer: serverName is required');
    }
    const client = this._mcpClients.get(serverName);
    let removed = false;
    if (client) {
      try {
        if (typeof client.close === 'function') {
          client.close();
        }
      } catch {
        // ignore connector close errors; the registry state is still revoked
      }
      this._mcpClients.delete(serverName);
      removed = true;
    }
    let toolsRemoved = 0;
    for (const [name, entry] of this._tools.entries()) {
      if (entry.source === `mcp:${serverName}`) {
        this._tools.delete(name);
        toolsRemoved += 1;
      }
    }
    return { name: serverName, removed, toolsRemoved };
  }

  mcpServers() {
    return [...this._mcpClients.keys()];
  }
}

export function createToolRegistry() {
  return new ToolRegistry();
}
