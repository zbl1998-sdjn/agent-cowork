// @ts-check

// 统一工具注册表(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把「内置工具」(sandbox/run-code/recipes/web/data…)与「MCP 服务器工具」
//       收拢到同一命名空间,提供 list/search/get/call,以及 MCP 客户端的接入/吊销。
// 设计:MCP 工具按 `mcp__<server>__<tool>` 命名空间隔离,既不与内置工具撞名,也能
//       从名字反推来源服务器;search 即「按需暴露」的 ToolSearch 模拟(详见下方英文)。
// 依赖:无内部依赖(只持有调用方注入的 handler 与 MCP client)。导出:ToolRegistry / createToolRegistry。
//
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

/** 把查询/描述切成小写词元(按非字母数字下划线点分隔),用于关键词打分。 @param {unknown} text */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter(Boolean);
}

/**
 * 给工具描述符按命中词打分(名字命中 +3,描述命中 +1),用于 search 排序。
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

/** 工具注册表:内置工具与 MCP 工具的统一登记/检索/调用中枢。 */
export class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolEntry>} */
    this._tools = new Map();
    /** @type {Map<string, McpClient>} */
    this._mcpClients = new Map();
  }

  /** 登记一个工具(校验 name/handler,补齐 risk/mutating/requiresApproval 默认值)。 @param {ToolEntry} entry */
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

  /** 批量登记。 @param {ToolEntry[]} [entries] */
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

  /** 返回单个工具的「脱敏描述符」(不含 handler,可安全暴露给前端/模型)。 @param {string} name */
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

  /** 列出全部工具描述符(不泄露 handler)。 @returns {ToolDescriptor[]} */
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
   * 按关键词检索并打分排序,返回最相关的若干工具(MCP 工具多时按需暴露,避免一次性塞满)。
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
   * 按名调用工具的 handler;未知工具抛 404。
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
   * 接入一个 MCP 服务器:连接、拉取其工具清单,并以 `mcp__server__tool` 命名空间登记;
   * MCP 工具默认高风险、需审批。返回导入的工具数。
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

  /** 吊销某 MCP 服务器:关闭客户端并移除其全部工具,返回移除统计。 @param {string} serverName */
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

  /** 当前已接入的 MCP 服务器名清单。 */
  mcpServers() {
    return [...this._mcpClients.keys()];
  }
}

/** 创建一个空的工具注册表。 */
export function createToolRegistry() {
  return new ToolRegistry();
}
