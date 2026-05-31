// 统一工具注册表(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:把内置工具与 MCP 服务器工具收拢到同一命名空间,提供 list/search/get/call,
//       以及 MCP 客户端的接入/吊销。注册入口的运行时校验放在同层 input schema。

import { parseMcpTools, parseToolEntry } from './tool-registry-inputs.js';

type HttpError = Error & { statusCode?: number };

type BivariantToolHandler = {
  bivarianceHack(args?: unknown, ctx?: unknown): unknown | Promise<unknown>;
};

export type ToolHandler = BivariantToolHandler['bivarianceHack'];
export type ToolEntry = {
  name: string;
  description?: string;
  source?: string;
  inputSchema?: unknown;
  risk?: string;
  mutating?: boolean;
  requiresApproval?: boolean;
  handler: ToolHandler;
};
export type ToolDescriptor = {
  name: string;
  description: string;
  source: string;
  inputSchema: unknown;
  risk: string;
  mutating: boolean;
  requiresApproval: boolean;
};
export type ToolSearchResult = ToolDescriptor & { score?: number };
export type McpTool = { name: string; description?: string; inputSchema?: unknown };
export type McpClient = {
  connect(): void | Promise<void>;
  listTools(): McpTool[] | Promise<McpTool[]>;
  callTool(name: string, args?: unknown): unknown | Promise<unknown>;
  close?: () => void;
};

/** 把查询/描述切成小写词元,用于关键词打分。 */
function tokenize(text: unknown): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.]+/)
    .filter(Boolean);
}

/** 给工具描述符按命中词打分:名字命中 +3,描述命中 +1。 */
function scoreTool(descriptor: ToolDescriptor, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const name = descriptor.name.toLowerCase();
  const haystack = `${name} ${descriptor.description.toLowerCase()}`;
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) {
      score += 3;
    } else if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function toDescriptor(entry: ToolEntry): ToolDescriptor {
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

/** 工具注册表:内置工具与 MCP 工具的统一登记/检索/调用中枢。 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly mcpClients = new Map<string, McpClient>();

  /** 登记一个工具,校验 name/handler 并补齐默认值。 */
  register(entry: unknown): this {
    const input = parseToolEntry(entry);
    this.tools.set(input.name, {
      name: input.name,
      description: input.description || '',
      source: input.source || 'builtin',
      inputSchema: input.inputSchema || null,
      risk: input.risk || 'low',
      mutating: input.mutating === true,
      requiresApproval: input.requiresApproval === true,
      handler: input.handler,
    });
    return this;
  }

  registerMany(entries: readonly unknown[] = []): this {
    for (const entry of entries) {
      this.register(entry);
    }
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolEntry | null {
    return this.tools.get(name) || null;
  }

  /** 返回单个工具的脱敏描述符,不含 handler。 */
  descriptor(name: string): ToolDescriptor | null {
    const entry = this.tools.get(name);
    return entry ? toDescriptor(entry) : null;
  }

  /** 列出全部工具描述符,不泄露 handler。 */
  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(toDescriptor);
  }

  /** 按关键词检索并打分排序,用于 MCP 工具按需暴露。 */
  search(query: string, { limit = 10 }: { limit?: number } = {}): ToolSearchResult[] {
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

  /** 按名调用工具 handler;未知工具抛 404。 */
  async call(name: string, args: unknown = {}, ctx: unknown = {}): Promise<unknown> {
    const entry = this.tools.get(name);
    if (!entry) {
      const err = new Error(`Unknown tool: ${name}`) as HttpError;
      err.statusCode = 404;
      throw err;
    }
    return entry.handler(args, ctx);
  }

  /** 接入 MCP 服务器,以 `mcp__server__tool` 命名空间登记其工具。 */
  async registerMcpClient(serverName: string, client: McpClient): Promise<number> {
    if (!serverName || !client) {
      throw new Error('registerMcpClient: serverName and client are required');
    }
    await client.connect();
    const tools = parseMcpTools(await client.listTools());
    this.mcpClients.set(serverName, client);
    for (const tool of tools) {
      this.register({
        name: `mcp__${serverName}__${tool.name}`,
        description: tool.description || '',
        source: `mcp:${serverName}`,
        inputSchema: tool.inputSchema || null,
        risk: 'high',
        mutating: true,
        requiresApproval: true,
        handler: (args?: unknown) => client.callTool(tool.name, args),
      });
    }
    return tools.length;
  }

  /** 吊销某 MCP 服务器:关闭客户端并移除其全部工具。 */
  unregisterMcpServer(serverName: string): { name: string; removed: boolean; toolsRemoved: number } {
    if (!serverName) {
      throw new Error('unregisterMcpServer: serverName is required');
    }
    const client = this.mcpClients.get(serverName);
    let removed = false;
    if (client) {
      try {
        client.close?.();
      } catch {
        // ignore connector close errors; the registry state is still revoked
      }
      this.mcpClients.delete(serverName);
      removed = true;
    }
    let toolsRemoved = 0;
    for (const [name, entry] of this.tools.entries()) {
      if (entry.source === `mcp:${serverName}`) {
        this.tools.delete(name);
        toolsRemoved += 1;
      }
    }
    return { name: serverName, removed, toolsRemoved };
  }

  /** 当前已接入的 MCP 服务器名清单。 */
  mcpServers(): string[] {
    return [...this.mcpClients.keys()];
  }
}

/** 创建一个空的工具注册表。 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
